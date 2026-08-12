import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  listArCustomers,
  saveArCustomer,
  setArCustomerActive,
} from "@/lib/accounting/ar-customers.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ArCustomer = {
  id: string;
  account_code: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  active: boolean;
};

const emptyCustomer = {
  id: undefined as string | undefined,
  accountCode: "",
  name: "",
  email: "",
  phone: "",
  address: "",
};

export function ArCustomerManager({
  propertyId,
  open,
  onOpenChange,
  onChanged,
}: {
  propertyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const listFn = useServerFn(listArCustomers);
  const saveFn = useServerFn(saveArCustomer);
  const activeFn = useServerFn(setArCustomerActive);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyCustomer);

  const list = useQuery({
    queryKey: ["ar-customers", propertyId, "all", search],
    queryFn: () => listFn({ data: { propertyId, search, includeInactive: true } }),
    enabled: open,
  });
  const refresh = () => {
    onChanged();
    return list.refetch();
  };
  const save = useMutation({
    mutationFn: () => saveFn({ data: { ...form, propertyId } }),
    onSuccess: async () => {
      toast.success(form.id ? "AR customer updated" : "AR customer created");
      setEditing(false);
      setForm(emptyCustomer);
      await refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: (customer: ArCustomer) =>
      activeFn({ data: { propertyId, id: customer.id, active: !customer.active } }),
    onSuccess: async () => {
      toast.success("AR customer status updated");
      await refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const customers = (list.data ?? []) as ArCustomer[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>AR customer accounts</DialogTitle>
        </DialogHeader>
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </div>
              <div>
                <Label>Account code</Label>
                <Input
                  placeholder="Generated when blank"
                  value={form.accountCode}
                  onChange={(event) =>
                    setForm({ ...form, accountCode: event.target.value.toUpperCase() })
                  }
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Address</Label>
              <Textarea
                rows={2}
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setForm(emptyCustomer);
                }}
              >
                Cancel
              </Button>
              <Button disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
                Save customer
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="Search customers…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                onClick={() => {
                  setForm(emptyCustomer);
                  setEditing(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1" /> New customer
              </Button>
            </div>
            <div className="border rounded-md max-h-96 overflow-y-auto">
              {customers.map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 border-b last:border-0"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{customer.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {customer.account_code} · {customer.email ?? "No email"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant={customer.active ? "default" : "secondary"}>
                      {customer.active ? "Active" : "Inactive"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setForm({
                          id: customer.id,
                          accountCode: customer.account_code,
                          name: customer.name,
                          email: customer.email ?? "",
                          phone: customer.phone ?? "",
                          address: customer.address ?? "",
                        });
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(customer)}
                    >
                      {customer.active ? "Deactivate" : "Activate"}
                    </Button>
                  </div>
                </div>
              ))}
              {customers.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No AR customers found.
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
