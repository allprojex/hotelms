import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActiveProperty } from "@/hooks/use-active-property";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2, Copy, Printer, Download, FileText, FileSpreadsheet, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { useHasAnyRole, type AppRole } from "@/hooks/use-user-roles";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/settings_/roles-matrix")({
  head: () => ({ meta: [{ title: "Role Permission Matrix" }] }),
  component: RolesMatrix,
});

const BUILTIN_ROLES = [
  "super_admin","hotel_owner","general_manager","manager","front_desk","reservations",
  "cashier","restaurant_manager","waiter","kitchen","accountant","auditor",
  "housekeeping_supervisor","housekeeping","storekeeper","guest_relations","security","maintenance","hr",
];
const MODULES = [
  "reservations","calendar","guests","rooms","rates","housekeeping",
  "pos","menu","inventory","channels","accounting","reports","analytics","properties","settings","users","audit",
];
const ACTIONS = ["create","read","update","delete","approve","export","import","print","manage"] as const;
type Action = typeof ACTIONS[number];

function RolesMatrix() {
  const propertyId = useActiveProperty();
  const qc = useQueryClient();
  const adminRoles: AppRole[] = ["hotel_owner", "general_manager", "manager"];
  const { allowed: isAdmin } = useHasAnyRole(adminRoles, propertyId);
  const [selectedRole, setSelectedRole] = useState<{ kind: "builtin" | "custom"; key: string; id?: string }>({ kind: "builtin", key: "front_desk" });
  const [openCreate, setOpenCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const customRoles = useQuery({
    queryKey: ["custom-roles", propertyId], enabled: !!propertyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("custom_roles" as any).select("*").eq("property_id", propertyId!);
      if (error) throw error;
      return (data as any[]) ?? [];
    },
  });

  const perms = useQuery({
    queryKey: ["role-perms", propertyId, selectedRole.kind, selectedRole.key, selectedRole.id],
    enabled: !!propertyId,
    queryFn: async () => {
      let qb = supabase.from("role_permissions" as any).select("*").eq("property_id", propertyId!);
      if (selectedRole.kind === "builtin") qb = qb.eq("role", selectedRole.key).is("custom_role_id", null);
      else qb = qb.eq("custom_role_id", selectedRole.id!);
      const { data, error } = await qb;
      if (error) throw error;
      return (data as any[]) ?? [];
    },
  });

  const permMap = useMemo(() => {
    const m = new Map<string, boolean>();
    (perms.data ?? []).forEach((p: any) => m.set(`${p.module}:${p.action}`, p.allowed));
    return m;
  }, [perms.data]);

  async function toggle(mod: string, action: Action, next: boolean) {
    if (!propertyId) return;
    const payload: any = {
      property_id: propertyId, module: mod, action, allowed: next,
      role: selectedRole.kind === "builtin" ? selectedRole.key : null,
      custom_role_id: selectedRole.kind === "custom" ? selectedRole.id : null,
    };
    const conflict = "property_id,role,custom_role_id,module,action";
    const { error } = await (supabase.from("role_permissions" as any) as any)
      .upsert(payload, { onConflict: conflict });
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["role-perms"] });
  }

  async function createCustom() {
    if (!propertyId || !newName.trim()) return;
    const { error } = await (supabase.from("custom_roles" as any) as any).insert({
      property_id: propertyId, key: newName.toLowerCase().replace(/\s+/g, "_"),
      name: newName, description: newDesc,
    });
    if (error) return toast.error(error.message);
    toast.success("Role created"); setOpenCreate(false); setNewName(""); setNewDesc("");
    qc.invalidateQueries({ queryKey: ["custom-roles"] });
  }

  async function cloneFrom(sourceRole: string) {
    if (!propertyId || selectedRole.kind !== "custom") return toast.error("Select a custom role first");
    const { data: src } = await supabase.from("role_permissions" as any).select("module,action,allowed")
      .eq("property_id", propertyId).eq("role", sourceRole).is("custom_role_id", null);
    const rows = (src as any[] ?? []).map((p) => ({
      property_id: propertyId, custom_role_id: selectedRole.id, module: p.module, action: p.action, allowed: p.allowed,
    }));
    if (rows.length === 0) return toast.info("Source role has no permissions set");
    const { error } = await (supabase.from("role_permissions" as any) as any)
      .upsert(rows, { onConflict: "property_id,role,custom_role_id,module,action" });
    if (error) return toast.error(error.message);
    toast.success(`Cloned ${rows.length} permissions`);
    qc.invalidateQueries({ queryKey: ["role-perms"] });
  }

  async function deleteCustom(id: string) {
    if (!confirm("Delete this custom role?")) return;
    const { error } = await supabase.from("custom_roles" as any).delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted"); qc.invalidateQueries({ queryKey: ["custom-roles"] });
    setSelectedRole({ kind: "builtin", key: "front_desk" });
  }
  const roleLabel = selectedRole.kind === "builtin"
    ? selectedRole.key.replace(/_/g, " ")
    : ((customRoles.data ?? []).find((r: any) => r.id === selectedRole.id)?.name ?? selectedRole.key);

  function buildMatrixRows() {
    return MODULES.map((m) => {
      const row: Record<string, string> = { Module: m };
      ACTIONS.forEach((a) => { row[a] = permMap.get(`${m}:${a}`) ? "Yes" : "No"; });
      return row;
    });
  }

  function exportCSV() {
    const header = ["Module", ...ACTIONS];
    const rows = buildMatrixRows();
    const csv = [
      `Role,${roleLabel}`,
      header.join(","),
      ...rows.map((r) => header.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `role-matrix-${roleLabel.replace(/\s+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported CSV");
  }

  function printMatrix() {
    const header = ["Module", ...ACTIONS];
    const rows = buildMatrixRows();
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return toast.error("Popup blocked");
    win.document.write(`<!doctype html><html><head><title>Role Matrix — ${roleLabel}</title>
<style>
  body{font-family:system-ui,sans-serif;padding:24px;color:#111}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#666;font-size:12px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:center}
  th:first-child,td:first-child{text-align:left;text-transform:capitalize}
  thead th{background:#f3f4f6;text-transform:uppercase;font-size:10px}
  .yes{color:#065f46;font-weight:600} .no{color:#9ca3af}
</style></head><body>
<h1>Role Permission Matrix — ${roleLabel}</h1>
<div class="sub">${selectedRole.kind} role · generated ${new Date().toLocaleString("en-GB")}</div>
<table><thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>${rows.map((r) => `<tr>${header.map((h) => {
      const v = r[h];
      const cls = v === "Yes" ? "yes" : v === "No" ? "no" : "";
      return `<td class="${cls}">${v ?? ""}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>
<script>window.onload=()=>{window.print();}</script>
</body></html>`);
    win.document.close();
  }

  function exportPDF() {
    const header = ["Module", ...ACTIONS.map((a) => a.toUpperCase())];
    const rows = buildMatrixRows();
    const body = rows.map((r) => [r.Module, ...ACTIONS.map((a) => r[a] ?? "")]);
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    doc.setFontSize(14);
    doc.text(`Role Permission Matrix — ${roleLabel}`, 40, 40);
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`${selectedRole.kind} role · generated ${new Date().toLocaleString("en-GB")}`, 40, 56);
    autoTable(doc, {
      startY: 70,
      head: [header],
      body,
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [243, 244, 246], textColor: 40, fontStyle: "bold" },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index > 0) {
          const v = String(data.cell.raw ?? "");
          if (v === "Yes") { data.cell.styles.textColor = [6, 95, 70]; data.cell.styles.fontStyle = "bold"; }
          else if (v === "No") { data.cell.styles.textColor = [156, 163, 175]; }
        }
      },
    });
    doc.save(`role-matrix-${roleLabel.replace(/\s+/g, "_")}.pdf`);
    toast.success("Exported PDF");
  }




  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Role Permission Matrix</h1>
          <p className="text-sm text-muted-foreground">Grant or revoke actions per module for each role.</p>
        </div>
        <Dialog open={openCreate} onOpenChange={setOpenCreate}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-1" />New custom role</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create custom role</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Head Concierge" /></div>
              <div><Label>Description</Label><Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} /></div>
            </div>
            <DialogFooter><Button onClick={createCustom}>Create</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <Card className="p-2 max-h-[70vh] overflow-y-auto">
          <div className="text-xs font-semibold uppercase text-muted-foreground px-2 py-1">Built-in</div>
          {BUILTIN_ROLES.map((r) => (
            <button key={r} className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-muted ${selectedRole.kind==="builtin" && selectedRole.key===r ? "bg-primary/10 font-medium" : ""}`}
              onClick={() => setSelectedRole({ kind: "builtin", key: r })}>
              {r.replace(/_/g, " ")}
            </button>
          ))}
          <div className="text-xs font-semibold uppercase text-muted-foreground px-2 py-1 mt-3">Custom</div>
          {(customRoles.data ?? []).length === 0 && <div className="text-xs text-muted-foreground px-2">None yet</div>}
          {(customRoles.data ?? []).map((r: any) => (
            <div key={r.id} className={`flex items-center gap-1 px-2 py-1 rounded text-sm hover:bg-muted ${selectedRole.id===r.id ? "bg-primary/10" : ""}`}>
              <button className="flex-1 text-left" onClick={() => setSelectedRole({ kind: "custom", key: r.key, id: r.id })}>{r.name}</button>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => deleteCustom(r.id)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          ))}
        </Card>

        <Card className="p-3 overflow-x-auto">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <div>
              <div className="font-semibold capitalize">{roleLabel}</div>
              <Badge variant="outline" className="text-[10px] mt-1">{selectedRole.kind}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Download className="h-3 w-3 mr-1" />Download / Print
                      <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={exportCSV}>
                      <FileSpreadsheet className="h-4 w-4 mr-2" />Export as CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={exportPDF}>
                      <FileText className="h-4 w-4 mr-2" />Export as PDF
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={printMatrix}>
                      <Printer className="h-4 w-4 mr-2" />Print preview
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {selectedRole.kind === "custom" && (
                <Button size="sm" variant="outline" onClick={() => {
                  const src = prompt("Clone from built-in role (e.g. front_desk):");
                  if (src) cloneFrom(src);
                }}><Copy className="h-3 w-3 mr-1" />Clone from…</Button>
              )}
            </div>
          </div>

          <Table>
            <TableHeader><TableRow>
              <TableHead>Module</TableHead>
              {ACTIONS.map((a) => <TableHead key={a} className="text-center text-[10px] uppercase">{a}</TableHead>)}
            </TableRow></TableHeader>
            <TableBody>
              {MODULES.map((m) => (
                <TableRow key={m}>
                  <TableCell className="font-medium capitalize">{m}</TableCell>
                  {ACTIONS.map((a) => {
                    const key = `${m}:${a}`;
                    const checked = permMap.get(key) ?? false;
                    return (
                      <TableCell key={a} className="text-center">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggle(m, a, Boolean(v))} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
