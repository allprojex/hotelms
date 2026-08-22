#!/usr/bin/env node
// Multi-statement read-only SQL execution for supabase-preflight.mjs and
// supabase-verify.mjs.
//
// WHY THIS EXISTS: `supabase db query --db-url <url> --file <path>` submits
// the whole file as a single request over Postgres's extended/prepared-
// statement protocol, which — discovered against the real production
// pooler on 2026-08-22 — rejects any file containing more than one SQL
// statement with `ERROR: cannot insert multiple commands into a prepared
// statement (SQLSTATE 42601)`. This is a Postgres protocol-level rule, not
// specific to the pooler, and it broke every existing preflight/postflight
// file in this repo (all of which — by design and by this repo's own
// established convention, see supabase/preflight/*.sql — contain many
// separate SELECT statements in one file).
//
// DESIGN CHOICE — statement splitting vs. a different client mode: psql's
// own `-f <file>` execution uses the simple query protocol, which DOES
// accept multi-statement scripts natively, and was considered as an
// alternative to writing a SQL tokenizer here. Rejected: it would add a
// second CLI dependency (psql) of unverified availability across this
// toolkit's actual target environments, require a parallel error-masking
// implementation for a different tool's output format, and produce a
// different output format (table/CSV, not `--output json`) than every
// other script in this toolkit already relies on. This toolkit has
// deliberately used only the `supabase` CLI throughout (see the original
// security review: "zero raw psql usage anywhere") — splitting and
// executing each statement through the *same*, already-masked
// `supabase db query <single-statement>` call (the exact shape
// supabase-reload-postgrest.mjs already uses for its one hardcoded
// statement) keeps that property intact and reuses an already-working,
// already-tested code path instead of introducing a new one.
//
// SAFETY: splitting happens only AFTER the caller has already run
// assertReadOnlySqlFile() (guard.mjs) against the WHOLE file — that
// existing, unmodified check remains the first and authoritative gate.
// Every individual split statement is ALSO independently re-checked here
// (assertStatementReadOnly) using a stricter, tokenizer-based scan that
// (unlike the whole-file regex check) correctly ignores keywords inside
// string/identifier/dollar-quoted literals, not just comments — so a
// write keyword hidden after a valid SELECT, in any statement position,
// is caught by BOTH layers independently before anything runs.
//
// SECOND REAL FINDING (same day, this fix's own live validation): the
// obvious way to execute each split statement — pass its text as an
// inline `supabase db query <text>` argument via `shell: true` — HUNG
// against the real production pooler on the very first statement, with no
// connection ever reaching the database. Reproduced safely (no production
// contact) with a harmless stand-in command: a *multi-line* argument
// passed through `cmd.exe /d /s /c` (what Node's `shell: true` uses on
// Windows) comes out corrupted rather than cleanly quoted — Windows
// cmd.exe has no construct for an embedded newline inside one argument.
// Every real statement in this repo's preflight files spans multiple
// lines, so this broke immediately, not as a rare edge case. Fixed in
// execStatementViaSupabaseCli() below by writing each statement to a
// throwaway temp file and using `--file` per statement instead of inline
// text — see that function's own comment for the full explanation.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GuardError, runCliMasked, log, pass } from "./guard.mjs";

// Same keyword list as guard.mjs's assertReadOnlySqlFile — kept in sync
// deliberately (both must reject the same things; this one runs against a
// narrower, comment/string/quote-excluded slice of text than the other).
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|CALL|EXECUTE|VACUUM|REINDEX|COPY)\b/i;

/** Low-level SQL tokenizer. Walks the text once, classifying every
 * character range as one of: plain `code`, a single-quoted `string`
 * ('' is an escaped quote inside one), a double-quoted `ident`
 * (identifier; "" is an escaped quote), a `dollar`-quoted block
 * ($tag$...$tag$, tag may be empty as in $$...$$, matched to the SAME
 * closing tag), a `comment` (line `--...` to end of line, or block
 * `/*...*\/`, which Postgres allows to NEST — handled here with a depth
 * counter). Concatenating every run's `text` in order reproduces the
 * input exactly: this only classifies, it never rewrites or drops
 * anything. A bare `;` in `code` context is its own single-character
 * `code` run, so callers can find statement boundaries by scanning runs
 * rather than raw characters. */
export function tokenizeSql(sql) {
  const runs = [];
  let i = 0;
  const n = sql.length;
  const push = (type, text) => {
    if (text.length) runs.push({ type, text });
  };

  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : "";

    if (c === "-" && c2 === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push("comment", sql.slice(i, j));
      i = j;
      continue;
    }

    if (c === "/" && c2 === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      push("comment", sql.slice(i, j));
      i = j;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      push("string", sql.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      push("ident", sql.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }

    if (c === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const end = closeIdx === -1 ? n : closeIdx + tag.length;
        push("dollar", sql.slice(i, end));
        i = end;
        continue;
      }
    }

    if (c === ";") {
      push("code", ";");
      i += 1;
      continue;
    }

    // Plain code: consume up to the next character that starts a special
    // region, so we don't emit one run per character.
    let j = i + 1;
    while (j < n && !"-/'\"$;".includes(sql[j])) j++;
    // A lone '-' or '/' that isn't actually starting a comment must still
    // advance past itself (handled naturally since the while above only
    // stops at those chars, and the next loop iteration re-examines them
    // without matching the comment/dollar patterns, falling through here
    // again with j = i+1 minimum via the code below).
    if (j === i) j = i + 1;
    push("code", sql.slice(i, j));
    i = j;
  }

  return runs;
}

function joinRuns(runs) {
  return runs.map((r) => r.text).join("");
}

/** Every run's text EXCEPT comments — used to decide whether a split
 * fragment is "empty" (whitespace/comment-only) and should be dropped. */
function nonCommentText(sql) {
  return joinRuns(tokenizeSql(sql).filter((r) => r.type !== "comment"));
}

/** Only `code`-type run text (excludes comments AND string/identifier/
 * dollar-quoted literal content) — used for the write-keyword scan, so a
 * keyword appearing only inside a comment or a quoted literal can never
 * false-trigger, and a keyword actually used as an SQL command word is
 * always caught regardless of which statement position it's in. Runs are
 * joined with a single space so removing a string/comment between two
 * code runs can never accidentally glue two tokens into a new word. */
function codeOnlyText(sql) {
  return tokenizeSql(sql)
    .filter((r) => r.type === "code")
    .map((r) => r.text)
    .join(" ");
}

/** Splits a SQL text into individual top-level statements. NOT a naive
 * `split(';')` — semicolons inside single-quoted strings, double-quoted
 * identifiers, dollar-quoted blocks, line comments, and (nestable) block
 * comments are correctly ignored, via tokenizeSql() above. Empty /
 * whitespace-only / comment-only fragments (including the one produced by
 * a trailing semicolon) are dropped. Statement order is preserved. */
export function splitSqlStatements(sql) {
  const runs = tokenizeSql(sql);
  const statements = [];
  let current = [];

  for (const run of runs) {
    if (run.type === "code" && run.text === ";") {
      statements.push(joinRuns(current));
      current = [];
    } else {
      current.push(run);
    }
  }
  if (current.length) statements.push(joinRuns(current));

  return statements.map((s) => s.trim()).filter((s) => nonCommentText(s).trim().length > 0);
}

/** Per-statement read-only guard — a second, independent, tokenizer-based
 * layer on top of guard.mjs's whole-file assertReadOnlySqlFile(). Throws
 * GuardError, naming the 1-based statement index, never the statement text
 * itself (statements may contain literals from the SQL file that
 * shouldn't be echoed into a log line any more than strictly needed). */
export function assertStatementReadOnly(statementText, index) {
  const codeOnly = codeOnlyText(statementText);
  const found = codeOnly.match(WRITE_KEYWORDS)?.[0];
  if (found) {
    throw new GuardError(
      `Statement ${index} contains a non-read-only keyword ("${found}") outside comments/string ` +
        "literals — refusing to execute it as part of a read-only preflight/verification run.",
    );
  }
}

/** The real per-statement executor: the same masked CLI wrapper every other
 * supabase call in this toolkit uses. Writes the single statement to a
 * throwaway temp file and runs `supabase db query --file <tempfile>`,
 * rather than passing the statement text as an inline CLI argument.
 *
 * THIS MATTERS, NOT JUST STYLE: passing a multi-line statement as an
 * inline `shell: true` argument HANGS on Windows — confirmed directly
 * against production during this fix's own validation (a preflight run
 * stopped dead at "statement 1/13: running..." for 2+ minutes with no
 * open connection ever reaching the database — `netstat` showed nothing
 * on port 5432 while it was "running"). Reproduced safely afterward with a
 * harmless stand-in command (`node -e` echoing its own argv) instead of
 * `supabase`: a multi-line argument through `cmd.exe /d /s /c` (what
 * `shell: true` uses on Windows) comes out corrupted/truncated rather than
 * cleanly quoted — Windows cmd.exe has no construct for an embedded
 * newline inside one command-line argument the way a POSIX shell does.
 * Every real preflight/postflight statement in this repo's actual files
 * spans multiple lines, so this wasn't a rare edge case — it broke the
 * very first live statement, every time.
 *
 * Writing to a temp file sidesteps shell-argument parsing entirely: the
 * only thing that goes through argv/shell is the temp file's own path (a
 * short, single-line, special-character-free string), while the CLI reads
 * the actual (possibly multi-line) SQL content directly from disk. Cleaned
 * up in a `finally` block so a failed statement still removes its temp
 * file. The temp file's content is exactly the statement text and nothing
 * else — never combined with any other statement — so this doesn't
 * reopen the original multi-statement-per-file problem this whole module
 * exists to fix.
 *
 * Exported separately from runReadOnlySqlStatements so tests can inject a
 * fake executor and prove the orchestration logic (stop-on-first-failure,
 * statement order) without needing a live database — the fake never
 * bypasses runCliMasked's own redaction, since that's exercised directly
 * by this same executor whenever it's actually used for real. */
export async function execStatementViaSupabaseCli(url, statementText) {
  const dir = mkdtempSync(path.join(tmpdir(), "sql-runner-stmt-"));
  const file = path.join(dir, "statement.sql");
  try {
    writeFileSync(file, statementText, "utf8");
    return await runCliMasked(
      "supabase",
      ["db", "query", "--db-url", url, "--file", file, "--output", "json"],
      { maxBuffer: 20 * 1024 * 1024, shell: true, timeout: 30_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Splits `sqlText` into statements, independently re-validates each as
 * read-only, then executes them ONE AT A TIME via `execStatement` (defaults
 * to execStatementViaSupabaseCli — override only in tests) — never the
 * whole file as one request (see this file's header for why). Stops
 * immediately on the first failure (a thrown error from either the guard or
 * the executor propagates out of the loop, so no later statement ever
 * runs) and never logs statement SQL text — only its 1-based index/total
 * and the query's own result output. */
export async function runReadOnlySqlStatements(
  url,
  sqlText,
  { label, execStatement = execStatementViaSupabaseCli },
) {
  const statements = splitSqlStatements(sqlText);
  if (statements.length === 0) {
    throw new GuardError("No executable SQL statements found after parsing this file.");
  }

  const results = [];
  for (let i = 0; i < statements.length; i++) {
    const ordinal = i + 1;
    const stmt = statements[i];
    assertStatementReadOnly(stmt, ordinal);

    log(label, `statement ${ordinal}/${statements.length}: running ...`);
    let stdout, stderr;
    try {
      ({ stdout, stderr } = await execStatement(url, stmt));
    } catch (e) {
      e.message = `Statement ${ordinal}/${statements.length} failed: ${e.message}`;
      throw e;
    }
    pass(label, `statement ${ordinal}/${statements.length}: PASS`);
    if (stdout?.trim()) process.stdout.write(stdout);
    if (stderr?.trim())
      log(label, `statement ${ordinal}/${statements.length} stderr: ${stderr.trim()}`);
    results.push({ index: ordinal, total: statements.length, stdout, stderr });
  }
  return results;
}
