import { BRAND_NAME, pageTitle } from "@/lib/deployment-identity";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPrinters, savePrinter, deletePrinter, listPrintJobs, recordPrintJob } from "@/lib/printer/printers.functions";
import { usePrintNodePrinters } from "@/hooks/use-printnode";
import { sendPrintNodeJob } from "@/lib/printer/printnode.functions";
import {
  webPrinterSupport, requestUsbPrinter, sendUsbBytes,
  requestBluetoothPrinter, sendBluetoothBytes,
  requestSerialPrinter, sendSerialBytes, browserPrint,
} from "@/hooks/use-web-printer";
import { buildReceipt } from "@/lib/print/escpos";
import { buildZplLabel } from "@/lib/print/zpl";
import { useActiveProperty } from "@/hooks/use-active-property";
import { useHasAnyRole } from "@/hooks/use-user-roles";
import { ADMIN_ROLES } from "@/lib/admin/permissions";
import { AccessDenied } from "@/components/access-denied";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Printer, Usb, Bluetooth, Cable, Cloud, Wifi, Play, Trash2, TestTube, ListChecks, Route as RouteIcon } from "lucide-react";
import { PrintQueueTab } from "@/components/printer/print-queue-tab";
import { RoutingRulesTab } from "@/components/printer/routing-rules-tab";
import { format } from "date-fns";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin_/printers")({
  head: () => ({
    meta: [
      { title: pageTitle("Printers") },
      { name: "description", content: "Universal print manager — pair USB, Bluetooth, and cloud printers for receipts, invoices, labels, and documents." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PrintersPage,
});

function PrintersPage() {
  const propertyId = useActiveProperty();
  const gate = useHasAnyRole(ADMIN_ROLES, propertyId);
  const [tab, setTab] = useState("registered");

  if (gate.loading) return <div className="p-6 text-muted-foreground">Checking access…</div>;
  if (!gate.allowed) return <AccessDenied message="Only admins can manage printers." />;
  if (!propertyId) return <AccessDenied message="Select a property from the header first." />;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex items-center gap-3">
        <Printer className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Universal Print Manager</h1>
          <p className="text-xs text-muted-foreground">
            Pair browser-native printers (USB, Bluetooth, Serial) for instant receipts and labels, or connect any OS printer through PrintNode for PDFs, invoices, and full documents.
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="registered" className="gap-1.5"><Printer className="h-3.5 w-3.5" />Registered</TabsTrigger>
          <TabsTrigger value="pair" className="gap-1.5"><Usb className="h-3.5 w-3.5" />Pair new</TabsTrigger>
          <TabsTrigger value="cloud" className="gap-1.5"><Cloud className="h-3.5 w-3.5" />Cloud (PrintNode)</TabsTrigger>
          <TabsTrigger value="routing" className="gap-1.5"><RouteIcon className="h-3.5 w-3.5" />Routing rules</TabsTrigger>
          <TabsTrigger value="queue" className="gap-1.5"><ListChecks className="h-3.5 w-3.5" />Job queue</TabsTrigger>
          <TabsTrigger value="jobs" className="gap-1.5"><Play className="h-3.5 w-3.5" />Test print</TabsTrigger>
        </TabsList>

        <TabsContent value="registered"><RegisteredTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="pair"><PairTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="cloud"><CloudTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="routing"><RoutingRulesTab propertyId={propertyId} /></TabsContent>
        <TabsContent value="queue"><PrintQueueTab /></TabsContent>
        <TabsContent value="jobs"><JobsTab propertyId={propertyId} /></TabsContent>
      </Tabs>
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const map: Record<string, any> = {
    webusb: Usb, webbluetooth: Bluetooth, webserial: Cable,
    printnode: Cloud, network: Wifi,
  };
  const Icon = map[kind] ?? Printer;
  return <Icon className="h-3.5 w-3.5" />;
}

function RegisteredTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listPrinters);
  const delFn = useServerFn(deletePrinter);
  const recordFn = useServerFn(recordPrintJob);
  const list = useQuery({ queryKey: ["printers"], queryFn: () => listFn() });
  const del = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["printers"] }); toast.success("Printer removed."); },
  });

  async function testPrint(p: any) {
    try {
      if (p.kind === "printnode" && p.printnode_id) {
        // Simple text via raw
        const encoded = btoa(`${BRAND_NAME} — Test print\n\n\n\n`);
        const res: any = await sendPrintNodeJob({ data: {
          printnodeId: Number(p.printnode_id),
          title: `Test — ${p.name}`,
          contentType: "raw_base64",
          content: encoded,
        }});
        if (!res.ok) throw new Error(res.error);
      } else if (p.protocol === "zpl") {
        const bytes = buildZplLabel({ title: "TEST LABEL", price: "₵0.00", barcode: "1234567890", barcodeType: "CODE128" });
        await pairAndSend(p.kind, bytes);
      } else {
        const bytes = buildReceipt("TEST RECEIPT", [
          { type: "text", text: BRAND_NAME, align: "center" },
          { type: "text", text: format(new Date(), "dd/MM/yyyy HH:mm"), align: "center" },
          { type: "hr" },
          { type: "text", text: "If you can read this, the printer works." },
        ]);
        await pairAndSend(p.kind, bytes);
      }
      await recordFn({ data: { propertyId, printerId: p.id, jobType: "receipt", title: `Test — ${p.name}`, status: "completed" } });
      toast.success("Test job sent.");
    } catch (e: any) {
      toast.error(e.message ?? "Test print failed.");
      await recordFn({ data: { propertyId, printerId: p.id, jobType: "receipt", title: `Test — ${p.name}`, status: "failed", error: e.message } });
    }
  }

  async function pairAndSend(kind: string, bytes: Uint8Array) {
    if (kind === "webusb") { const d = await requestUsbPrinter(); await sendUsbBytes(d, bytes); }
    else if (kind === "webbluetooth") { const d = await requestBluetoothPrinter(); await sendBluetoothBytes(d, bytes); }
    else if (kind === "webserial") { const d = await requestSerialPrinter(); await sendSerialBytes(d, bytes); }
    else throw new Error("Unsupported browser transport — use Pair to reconnect.");
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Registered printers</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Kind</TableHead><TableHead>Protocol</TableHead>
            <TableHead>Default</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(list.data ?? []).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm font-medium">{p.name}<span className="ml-2 text-xs text-muted-foreground">{p.model}</span></TableCell>
                <TableCell><Badge variant="outline" className="gap-1"><KindIcon kind={p.kind} />{p.kind}</Badge></TableCell>
                <TableCell className="text-xs uppercase">{p.protocol}</TableCell>
                <TableCell>{p.is_default && <Badge variant="secondary">Default</Badge>}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" className="gap-1 mr-2" onClick={() => testPrint(p)}>
                    <TestTube className="h-3.5 w-3.5" />Test
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => del.mutate(p.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </TableCell>
              </TableRow>
            ))}
            {(list.data ?? []).length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                No printers registered yet — go to <b>Pair new</b> to add one.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PairTab({ propertyId }: { propertyId: string }) {
  const support = webPrinterSupport();
  const qc = useQueryClient();
  const saveFn = useServerFn(savePrinter);
  const [dialog, setDialog] = useState<{ kind: string; model?: string } | null>(null);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"escpos" | "zpl" | "raw" | "pdf">("escpos");
  const [makeDefault, setMakeDefault] = useState(false);

  const save = useMutation({
    mutationFn: () => saveFn({ data: {
      propertyId, name, kind: dialog!.kind as any, protocol,
      model: dialog!.model, is_default: makeDefault,
    }}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["printers"] });
      setDialog(null); setName(""); setMakeDefault(false); setProtocol("escpos");
      toast.success("Printer registered.");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to register."),
  });

  async function pairUsb() {
    try {
      const d: any = await requestUsbPrinter();
      setDialog({ kind: "webusb", model: `USB ${d.productName ?? d.productId}` });
      setName(d.productName ?? "USB Printer");
    } catch (e: any) { toast.error(e.message); }
  }
  async function pairBt() {
    try {
      const d: any = await requestBluetoothPrinter();
      setDialog({ kind: "webbluetooth", model: `BT ${d.name ?? d.id}` });
      setName(d.name ?? "Bluetooth Printer");
    } catch (e: any) { toast.error(e.message); }
  }
  async function pairSerial() {
    try {
      await requestSerialPrinter();
      setDialog({ kind: "webserial", model: "Serial" });
      setName("Serial Printer");
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <PairCard icon={Usb} title="USB (WebUSB)" description="ESC/POS thermal, ZPL label printers plugged into this computer."
        supported={support.webusb} onPair={pairUsb} />
      <PairCard icon={Bluetooth} title="Bluetooth" description="Mobile thermal printers, portable label printers."
        supported={support.webbluetooth} onPair={pairBt} />
      <PairCard icon={Cable} title="Serial / RS-232" description="Older thermal printers via USB-serial adapter."
        supported={support.webserial} onPair={pairSerial} />

      <Card className="md:col-span-3">
        <CardHeader><CardTitle className="text-base">Browser vs cloud printing</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-2">
          <p><b>Browser-native</b> works in Chrome/Edge on desktop and Chrome on Android. It talks directly to the device you pair — great for POS receipts and shelf labels. Safari/iOS do not expose USB/Bluetooth to the web.</p>
          <p><b>PrintNode (cloud)</b> reaches any OS-installed printer — including networked office multifunctions — and prints PDF, DOCX, and image documents. Set <code>PRINTNODE_API_KEY</code> in project secrets to enable.</p>
        </CardContent>
      </Card>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Register printer</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label>Protocol</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="escpos">ESC/POS (thermal receipts)</SelectItem>
                  <SelectItem value="zpl">ZPL (Zebra labels)</SelectItem>
                  <SelectItem value="raw">Raw bytes</SelectItem>
                  <SelectItem value="pdf">PDF (via system dialog)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
              Set as default for this property
            </label>
          </div>
          <DialogFooter>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !name}>
              {save.isPending ? "Saving…" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PairCard({ icon: Icon, title, description, supported, onPair }: {
  icon: any; title: string; description: string; supported: boolean; onPair: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" />{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{description}</p>
        {supported ? (
          <Button onClick={onPair} className="w-full">Pair {title}</Button>
        ) : (
          <div className="text-xs text-amber-500">
            Not supported in this browser. Use Chrome or Edge on desktop.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CloudTab({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const cloud = usePrintNodePrinters();
  const saveFn = useServerFn(savePrinter);
  const save = useMutation({
    mutationFn: (p: any) => saveFn({ data: {
      propertyId,
      name: p.name,
      kind: "printnode",
      protocol: "pdf",
      model: p.description || p.computer?.name,
      printnode_id: String(p.id),
    }}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["printers"] }); toast.success("Cloud printer registered."); },
    onError: (e: any) => toast.error(e.message ?? "Failed."),
  });

  if (cloud.isLoading) return <Card><CardContent className="p-8 text-center text-muted-foreground">Loading cloud printers…</CardContent></Card>;
  const data = cloud.data;
  if (!data?.available) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">PrintNode not configured</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Add the <code>PRINTNODE_API_KEY</code> secret in project settings to reach every OS-installed printer on any paired computer — including networked office multifunctions.</p>
          <p>Get an API key from your PrintNode account, then paste it into the secrets panel. Once set, all printers show up here automatically.</p>
          {data?.error && <p className="text-xs text-destructive">{data.error}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Available cloud printers</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Computer</TableHead><TableHead>State</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(data.printers ?? []).map((p: any) => (
              <TableRow key={p.id}>
                <TableCell className="text-sm font-medium">{p.name}</TableCell>
                <TableCell className="text-xs">{p.computer?.name ?? "—"}</TableCell>
                <TableCell><Badge variant={p.state === "online" ? "secondary" : "outline"}>{p.state}</Badge></TableCell>
                <TableCell className="text-right">
                  <Button size="sm" onClick={() => save.mutate(p)}>Register</Button>
                </TableCell>
              </TableRow>
            ))}
            {(data.printers ?? []).length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                No printers reported by PrintNode.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function JobsTab({ propertyId: _p }: { propertyId: string }) {
  const listFn = useServerFn(listPrintJobs);
  const list = useQuery({ queryKey: ["print-jobs"], queryFn: () => listFn() });

  function browserFallback() {
    browserPrint(`<h1>${BRAND_NAME}</h1><p>Sample document sent via the browser print dialog.</p>
      <p>Use this fallback for any file format your browser can render: PDF (open first in a viewer), DOCX (via preview), images, HTML pages.</p>`);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Universal document print</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            For invoices, contracts, or any file format not natively supported by ESC/POS or ZPL, use the browser's system print dialog — it routes to every OS-installed printer.
          </p>
          <Button onClick={browserFallback} className="gap-1.5"><Printer className="h-3.5 w-3.5" />Test system print</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent print jobs</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>When</TableHead><TableHead>Job</TableHead><TableHead>Title</TableHead>
              <TableHead>Copies</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(list.data ?? []).map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-xs whitespace-nowrap">{format(new Date(j.created_at), "dd/MM/yyyy HH:mm")}</TableCell>
                  <TableCell className="text-xs uppercase">{j.job_type}</TableCell>
                  <TableCell className="text-xs">{j.title ?? "—"}</TableCell>
                  <TableCell className="text-xs">{j.copies}</TableCell>
                  <TableCell>
                    <Badge variant={j.status === "completed" ? "secondary" : j.status === "failed" ? "destructive" : "outline"}>
                      {j.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {(list.data ?? []).length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No print jobs yet.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
