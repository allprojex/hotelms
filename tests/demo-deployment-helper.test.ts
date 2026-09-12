import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const helper = readFileSync("deploy/demo/deploy-demo.sh", "utf8");

describe("permanent Demo deployment helper", () => {
  it("accepts only an explicit full approved SHA", () => {
    expect(helper).toContain('[[ "$APPROVED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(helper).toContain('[[ "$FETCHED_SHA" = "$APPROVED_SHA" ]]');
  });

  it("uses the approved commit's lockfile without a destructive repository reset", () => {
    expect(helper).toContain('restore package-lock.json');
    expect(helper).not.toContain("LOCK_BACKUP_DIR");
    expect(helper).not.toContain('install -m 600 -o "$DEMO_USER"');
    expect(helper).not.toMatch(/git\s+reset|git\s+clean/);
  });

  it("refuses production identity in Demo inputs and output", () => {
    expect(helper).toContain('PRODUCTION_REF="texhuavnrdhaohqzlyqw"');
    expect(helper).toContain('DEMO_REF="akcppyymgoubsqedpkch"');
    expect(helper).toContain('grep -q "$PRODUCTION_REF" "$DEMO_DIR/.env.demo"');
    expect(helper).toContain('grep -rq "$PRODUCTION_REF" "$DEMO_DIR/.output"');
  });

  it("builds in Demo mode and restarts only the Demo unit", () => {
    expect(helper).toContain("npm run build -- --mode demo");
    expect(helper).toContain('systemctl restart "$DEMO_SERVICE"');
    expect(helper).not.toContain('systemctl restart "$PRODUCTION_SERVICE"');
    expect(helper).not.toMatch(/pm2|port 3000|:3000/);
  });

  it("fails if the Production PID, SHA, service, or health changes", () => {
    expect(helper).toContain('[[ "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE" ]]');
    expect(helper).toContain('[[ "$PRODUCTION_SHA_AFTER" = "$PRODUCTION_SHA_BEFORE" ]]');
    expect(helper.match(/systemctl is-active --quiet "\$PRODUCTION_SERVICE"/g)).toHaveLength(2);
    expect(helper.match(/PRODUCTION_PORT\/api\/public\/health/g)).toHaveLength(2);
  });
});
