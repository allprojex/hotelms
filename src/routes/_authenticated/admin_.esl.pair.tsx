import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lookupEslPairingCode, redeemEslPairingCode } from "@/lib/esl/devices.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { QrCode, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

type Search = { code?: string };

export const Route = createFileRoute("/_authenticated/admin_/esl/pair")({
  head: () => ({ meta: [{ title: "Pair Device · ESL" }, { name: "robots", content: "noindex" }] }),
  validateSearch: (s: Record<string, unknown>): Search => ({
    code: typeof s.code === "string" ? s.code : undefined,
  }),
  component: PairPage,
});

function PairPage() {
  const nav = useNavigate();
  const search = useSearch({ from: "/_authenticated/admin_/esl/pair" });
  const lookupFn = useServerFn(lookupEslPairingCode);
  const redeemFn = useServerFn(redeemEslPairingCode);

  const [code, setCode] = useState<string>(search.code ?? "");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [vendor, setVendor] = useState("");
  const [model, setModel] = useState("");

  const lookup = useQuery({
    queryKey: ["esl-pairing-code", code],
    enabled: !!code && code.length >= 6,
    queryFn: () => lookupFn({ data: { code } }),
  });

  useEffect(() => {
    if (lookup.data?.suggested_name && !name) setName(lookup.data.suggested_name);
  }, [lookup.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const redeem = useMutation({
    mutationFn: () => redeemFn({ data: { code, name, address, vendor, model } }),
    onSuccess: (res) => {
      toast.success("Device paired.");
      nav({ to: "/admin/esl", hash: `device-${res.deviceId}` });
    },
    onError: (e: any) => toast.error(e.message ?? "Pairing failed."),
  });

  const pc = lookup.data;
  const expired = pc && new Date(pc.expires_at) < new Date();
  const used = pc?.consumed_at != null;
  const ok = pc && !expired && !used;

  return (
    <div className="p-4 md:p-6 max-w-xl mx-auto">
      <header className="flex items-center gap-3 mb-4">
        <QrCode className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-display font-semibold">Pair a scanning device</h1>
          <p className="text-xs text-muted-foreground">
            Complete registration for the device that was scanned into this pairing code.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader><CardTitle className="text-base">Pairing code</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().trim())} placeholder="ABCDEFGH" className="font-mono tracking-widest" />
          </div>

          {pc && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex items-center gap-2">
                {ok
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  : <AlertCircle className="h-4 w-4 text-destructive" />}
                <span className="font-medium">{ok ? "Ready to pair" : used ? "Already used" : "Expired"}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Kind <Badge variant="outline">{pc.kind}</Badge> · Connection <Badge variant="outline">{pc.connection}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                Expires {new Date(pc.expires_at).toLocaleString("en-GB")}
              </div>
            </div>
          )}

          {code && !lookup.isLoading && !pc && (
            <p className="text-xs text-destructive">No pairing code found.</p>
          )}

          {ok && (
            <div className="space-y-3 pt-2">
              <div>
                <Label>Device name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front-desk QR scanner" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Vendor</Label><Input value={vendor} onChange={(e) => setVendor(e.target.value)} /></div>
                <div><Label>Model</Label><Input value={model} onChange={(e) => setModel(e.target.value)} /></div>
              </div>
              <div>
                <Label>Address / identifier</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="MAC, IP, or COM port" />
              </div>
              <Button className="w-full" onClick={() => redeem.mutate()} disabled={redeem.isPending}>
                {redeem.isPending ? "Pairing…" : "Complete pairing"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
