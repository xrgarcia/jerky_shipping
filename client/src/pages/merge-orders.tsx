import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { GitMerge, Inbox, Loader2, CheckCircle2, XCircle, Clock, Package, PackageOpen, AlertTriangle, Search, RotateCcw, ChevronUp, ChevronDown } from "lucide-react";
import { ShipmentTagBadges } from "@/components/shipment-tag-badges";

interface MergeCandidateShipment {
  id: string;
  shipmentId: string;
  orderNumber: string;
  salesChannel: string;
  email: string;
  shippingName: string;
  shippingAddress: string;
  itemCount: number;
  items: Array<{ name: string; sku: string; quantity: number; unitPrice?: string | number | null }>;
  tags: string[];
  createdAt: string;
}

interface MergeCandidateGroup {
  groupKey: string;
  memberCount: number;
  shipments: MergeCandidateShipment[];
}

interface MergeCandidatesResponse {
  groups: MergeCandidateGroup[];
}

interface MergeQueueRow {
  id: number;
  parentShipmentId: string;
  parentOrderNumber: string;
  childShipmentId: string;
  childOrderNumber: string;
  childSalesChannel: string;
  state: string;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  mergedBy: string;
  createdAt: string;
  processedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface MergeQueueResponse {
  stats: Record<string, number>;
  recent: MergeQueueRow[];
}

const STATE_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "secondary",
  processing: "default",
  complete: "outline",
  failed: "destructive",
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

interface GroupSelectionState {
  parentShipmentId: string;
  selectedIds: Set<string>;
}

function MergeCandidateCard({
  group,
  onMerge,
  isMerging,
  activeMergeIds,
}: {
  group: MergeCandidateGroup;
  onMerge: (parentShipmentId: string, childShipmentIds: string[]) => void;
  isMerging: boolean;
  activeMergeIds: Set<string>;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const [selection, setSelection] = useState<GroupSelectionState>(() => ({
    parentShipmentId: group.shipments[0]?.shipmentId || "",
    selectedIds: new Set(group.shipments.map((s) => s.shipmentId)),
  }));
  const [showConfirm, setShowConfirm] = useState(false);

  const prevKnownIdsRef = useRef<Set<string>>(
    new Set(group.shipments.map((s) => s.shipmentId))
  );
  useEffect(() => {
    const currentIds = new Set(group.shipments.map((s) => s.shipmentId));
    const newShipments: string[] = [];
    for (const id of currentIds) {
      if (!prevKnownIdsRef.current.has(id)) newShipments.push(id);
    }
    const removedAny = [...prevKnownIdsRef.current].some((id) => !currentIds.has(id));

    if (newShipments.length === 0 && !removedAny) return;

    setSelection((prev) => {
      const next = new Set<string>();
      for (const id of prev.selectedIds) {
        if (currentIds.has(id)) next.add(id);
      }
      for (const id of newShipments) {
        next.add(id);
      }
      const parentStillExists = currentIds.has(prev.parentShipmentId);
      return {
        parentShipmentId: parentStillExists
          ? prev.parentShipmentId
          : group.shipments[0]?.shipmentId || "",
        selectedIds: next,
      };
    });

    prevKnownIdsRef.current = currentIds;
  }, [group.shipments]);

  const selectedChildren = group.shipments.filter(
    (s) =>
      s.shipmentId !== selection.parentShipmentId &&
      selection.selectedIds.has(s.shipmentId)
  );
  const parentShipment = group.shipments.find(
    (s) => s.shipmentId === selection.parentShipmentId
  );
  const canMerge = selectedChildren.length >= 1 && parentShipment;

  const consolidatedItems = useMemo(() => {
    if (!parentShipment) return [];
    const items = [...(parentShipment.items || [])];
    for (const child of selectedChildren) {
      items.push(...(child.items || []));
    }
    return items;
  }, [parentShipment, selectedChildren]);

  function toggleShipment(shipmentId: string) {
    setSelection((prev) => {
      const next = new Set(prev.selectedIds);
      if (next.has(shipmentId)) {
        if (shipmentId === prev.parentShipmentId) return prev;
        next.delete(shipmentId);
      } else {
        next.add(shipmentId);
      }
      return { ...prev, selectedIds: next };
    });
  }

  function setParent(shipmentId: string) {
    setSelection((prev) => {
      const next = new Set(prev.selectedIds);
      next.add(shipmentId);
      return { parentShipmentId: shipmentId, selectedIds: next };
    });
  }

  const firstShipment = group.shipments[0];
  const displayAddress = firstShipment
    ? `${firstShipment.shippingName} — ${firstShipment.shippingAddress}`
    : group.groupKey;

  return (
    <>
      <Card data-testid={`card-merge-group-${group.groupKey}`}>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm font-medium truncate" data-testid="text-group-address">
              {displayAddress}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {group.memberCount} orders in group
            </p>
          </div>
          <Button
            size="sm"
            disabled={!canMerge || isMerging}
            onClick={() => setShowConfirm(true)}
            data-testid="button-merge-group"
          >
            {isMerging && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            <GitMerge className="h-3 w-3 mr-1" />
            {canMerge
              ? `Merge ${selectedChildren.length + 1} orders`
              : "Select orders to merge"}
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4"></TableHead>
                <TableHead className="w-16">Parent</TableHead>
                <TableHead>Order #</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.shipments.map((shipment) => {
                const isExpanded = expandedIds.has(shipment.shipmentId);
                const isMergingThisRow = activeMergeIds.has(shipment.shipmentId);
                return (
                <Fragment key={shipment.shipmentId}>
                <TableRow
                  data-testid={`row-merge-candidate-${shipment.shipmentId}`}
                  className={isMergingThisRow ? "opacity-60" : undefined}
                >
                  <TableCell className="pl-4">
                    <Checkbox
                      checked={selection.selectedIds.has(shipment.shipmentId)}
                      onCheckedChange={() => toggleShipment(shipment.shipmentId)}
                      disabled={shipment.shipmentId === selection.parentShipmentId || isMergingThisRow}
                      data-testid={`checkbox-select-${shipment.shipmentId}`}
                    />
                  </TableCell>
                  <TableCell>
                    <input
                      type="radio"
                      name={`parent-${group.groupKey}`}
                      checked={selection.parentShipmentId === shipment.shipmentId}
                      onChange={() => setParent(shipment.shipmentId)}
                      disabled={isMergingThisRow}
                      className="accent-primary disabled:opacity-50"
                      data-testid={`radio-parent-${shipment.shipmentId}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-order-number-${shipment.shipmentId}`}>
                    <div className="flex items-center gap-2">
                      <span>{shipment.orderNumber}</span>
                      {isMergingThisRow && (
                        <Badge
                          variant="secondary"
                          className="gap-1 font-normal"
                          data-testid={`badge-merging-${shipment.shipmentId}`}
                        >
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Merging
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ShipmentTagBadges tags={shipment.tags || []} testIdPrefix={shipment.shipmentId} />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleExpanded(shipment.shipmentId)}
                      className="gap-2 -mx-2"
                      data-testid={`button-toggle-items-${shipment.shipmentId}`}
                      aria-expanded={isExpanded}
                      aria-controls={`items-detail-${shipment.shipmentId}`}
                    >
                      <PackageOpen className="h-4 w-4" />
                      <span className="font-semibold" data-testid={`text-item-count-${shipment.shipmentId}`}>
                        {shipment.itemCount} item{shipment.itemCount !== 1 ? "s" : ""}
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(shipment.createdAt)}
                  </TableCell>
                </TableRow>
                {isExpanded && (
                  <TableRow
                    className="bg-muted/30 hover:bg-muted/30"
                    data-testid={`row-items-expanded-${shipment.shipmentId}`}
                  >
                    <TableCell colSpan={6} className="py-4 px-6">
                      <div id={`items-detail-${shipment.shipmentId}`} className="border rounded-md overflow-hidden bg-background">
                        <table className="w-full">
                          <thead className="bg-muted">
                            <tr>
                              <th className="text-left px-4 py-3 font-semibold text-sm">SKU</th>
                              <th className="text-left px-4 py-3 font-semibold text-sm">Product</th>
                              <th className="text-center px-4 py-3 font-semibold text-sm">Quantity</th>
                              <th className="text-right px-4 py-3 font-semibold text-sm">Unit Price</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {shipment.items.length === 0 ? (
                              <tr>
                                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                                  No items found for this shipment
                                </td>
                              </tr>
                            ) : (
                              shipment.items.map((item, idx) => (
                                <tr key={idx} className="hover-elevate" data-testid={`row-item-${shipment.shipmentId}-${idx}`}>
                                  <td className="px-4 py-3">
                                    <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
                                      {item.sku || 'N/A'}
                                    </code>
                                  </td>
                                  <td className="px-4 py-3 text-sm">{item.name || 'Unknown Product'}</td>
                                  <td className="px-4 py-3 text-center">
                                    <span className="font-semibold">{item.quantity}</span>
                                  </td>
                                  <td className="px-4 py-3 text-right text-sm">
                                    {item.unitPrice != null && item.unitPrice !== ''
                                      ? `$${parseFloat(String(item.unitPrice)).toFixed(2)}`
                                      : 'N/A'}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent data-testid="dialog-merge-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5" />
              Confirm Merge
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Merging {selectedChildren.length + 1} orders into parent{" "}
                  <span className="font-mono font-semibold">{parentShipment?.orderNumber}</span>.
                  Children will stop shipping individually. This action cannot be undone.
                </p>
                <div className="border rounded-md p-3 bg-muted/30 max-h-48 overflow-y-auto">
                  <p className="text-xs font-medium mb-2">
                    Consolidated items ({consolidatedItems.length}):
                  </p>
                  <ul className="text-xs space-y-1">
                    {consolidatedItems.map((item, idx) => (
                      <li key={idx} className="flex items-center gap-1">
                        <Package className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        {item.quantity}x {item.sku} — {item.name}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-merge-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onMerge(
                  selection.parentShipmentId,
                  selectedChildren.map((c) => c.shipmentId)
                );
                setShowConfirm(false);
              }}
              data-testid="button-merge-confirm"
            >
              Confirm Merge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function MergeOrders() {
  const { toast } = useToast();
  const [stateFilter, setStateFilter] = useState("all");

  const {
    data: candidatesData,
    isLoading: candidatesLoading,
  } = useQuery<MergeCandidatesResponse>({
    queryKey: ["/api/merge-candidates"],
    refetchInterval: 15000,
  });

  const {
    data: queueData,
    isLoading: queueLoading,
  } = useQuery<MergeQueueResponse>({
    queryKey: ["/api/merge-queue"],
    refetchInterval: 15000,
  });

  const mergeMutation = useMutation({
    mutationFn: async ({
      parentShipmentId,
      childShipmentIds,
    }: {
      parentShipmentId: string;
      childShipmentIds: string[];
    }) => {
      const res = await apiRequest("POST", "/api/merges", {
        parentShipmentId,
        childShipmentIds,
      });
      return res.json();
    },
    onSuccess: (data: any, variables) => {
      toast({
        title: "Merge queued",
        description: `${data.mergeIds.length} child order(s) queued for merge.`,
      });

      queryClient.setQueryData<MergeCandidatesResponse>(
        ["/api/merge-candidates"],
        (old) => {
          if (!old) return old;
          const mergedChildIds = new Set(variables.childShipmentIds);
          const updatedGroups = old.groups
            .map((group) => {
              const remaining = group.shipments.filter(
                (s) => !mergedChildIds.has(s.shipmentId)
              );
              return {
                ...group,
                shipments: remaining,
                memberCount: remaining.length,
              };
            })
            .filter((group) => group.shipments.length >= 2);
          return { groups: updatedGroups };
        }
      );

      queryClient.invalidateQueries({ queryKey: ["/api/merge-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/merge-queue"] });
    },
    onError: (error: any) => {
      const errorMsg = error.data?.error || error.message || "Failed to create merge";
      const isConflict = error.status === 409;
      toast({
        title: isConflict ? "Merge conflict" : "Merge failed",
        description: errorMsg,
        variant: "destructive",
      });
      if (isConflict) {
        queryClient.invalidateQueries({ queryKey: ["/api/merge-candidates"] });
      }
    },
  });

  const stats = queueData?.stats || {};
  const totalJobs = Object.values(stats).reduce((a, b) => a + b, 0);

  const activeMergeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!queueData?.recent) return ids;
    for (const row of queueData.recent) {
      if (row.state === "queued" || row.state === "processing") {
        ids.add(row.parentShipmentId);
        ids.add(row.childShipmentId);
      }
    }
    return ids;
  }, [queueData?.recent]);

  const filteredRecent = useMemo(() => {
    if (!queueData?.recent) return [];
    if (stateFilter === "all") return queueData.recent;
    return queueData.recent.filter((r) => r.state === stateFilter);
  }, [queueData?.recent, stateFilter]);

  const groups = candidatesData?.groups || [];
  const [candidateSearch, setCandidateSearch] = useState("");

  const filteredGroups = useMemo(() => {
    if (!candidateSearch.trim()) return groups;
    const q = candidateSearch.toLowerCase();
    return groups.filter((g) =>
      g.shipments.some(
        (s) =>
          s.orderNumber.toLowerCase().includes(q) ||
          s.email.toLowerCase().includes(q) ||
          s.shippingName.toLowerCase().includes(q)
      )
    );
  }, [groups, candidateSearch]);

  const totalDuplicateOrders = groups.reduce((sum, g) => sum + g.memberCount, 0);

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto" data-testid="page-merge-orders">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Merge Orders</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Merge duplicate TikTok orders shipping to the same address into a single shipment.
        </p>
      </div>

      <section data-testid="section-merge-candidates">
        <h2 className="text-lg font-semibold mb-4">Pending Merge Candidates</h2>
        {candidatesLoading ? (
          <div className="space-y-4">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mb-3" />
              <p className="text-sm" data-testid="text-no-candidates">No candidate groups found</p>
              <p className="text-xs mt-1">All shippable orders have unique addresses.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span data-testid="text-candidates-group-count">
                  {groups.length} candidate group{groups.length !== 1 ? "s" : ""}
                </span>
                <span data-testid="text-candidates-order-count">
                  {totalDuplicateOrders} duplicate orders
                </span>
              </div>
              <div className="relative ml-auto">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, or order #"
                  value={candidateSearch}
                  onChange={(e) => setCandidateSearch(e.target.value)}
                  className="pl-9 w-64"
                  data-testid="input-candidate-search"
                />
              </div>
            </div>
            {filteredGroups.map((group) => (
              <MergeCandidateCard
                key={group.groupKey}
                group={group}
                onMerge={(parentShipmentId, childShipmentIds) =>
                  mergeMutation.mutate({ parentShipmentId, childShipmentIds })
                }
                isMerging={mergeMutation.isPending}
                activeMergeIds={activeMergeIds}
              />
            ))}
            {filteredGroups.length === 0 && candidateSearch && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No groups match "{candidateSearch}"
              </p>
            )}
          </div>
        )}
      </section>

      <section data-testid="section-merge-queue">
        <h2 className="text-lg font-semibold mb-4">Merge Queue</h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <Card data-testid="card-mq-queued">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Queued</CardTitle>
              <Inbox className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-mq-queued">{stats.queued ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-mq-processing">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Processing</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-mq-processing">{stats.processing ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-mq-complete">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Complete</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-mq-complete">{stats.complete ?? 0}</div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-mq-failed">
            <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <XCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <div className="text-2xl font-bold" data-testid="text-mq-failed">{stats.failed ?? 0}</div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="w-[140px]" data-testid="select-merge-state-filter">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="complete">Complete</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {filteredRecent.length} of {totalJobs} total
          </span>
        </div>

        {queueLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : filteredRecent.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <p className="text-sm" data-testid="text-no-queue-items">No merge queue items</p>
            </CardContent>
          </Card>
        ) : (
          <div className="border rounded-md overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent</TableHead>
                  <TableHead>Child</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Merged By</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Processed</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecent.map((row) => (
                  <TableRow key={row.id} data-testid={`row-merge-queue-${row.id}`}>
                    <TableCell className="font-mono text-sm" data-testid={`text-mq-parent-${row.id}`}>
                      {row.parentOrderNumber}
                    </TableCell>
                    <TableCell className="font-mono text-sm" data-testid={`text-mq-child-${row.id}`}>
                      {row.childOrderNumber}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{row.childSalesChannel}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATE_BADGE_VARIANT[row.state] || "secondary"}
                        data-testid={`badge-mq-state-${row.id}`}
                      >
                        {row.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{row.mergedBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.processedAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.completedAt)}
                    </TableCell>
                    <TableCell>
                      {row.lastError ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1.5">
                              <AlertTriangle className="h-4 w-4 text-destructive cursor-default" />
                              {row.state === "failed" && (
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <RotateCcw className="h-3 w-3" />
                                  Retry above
                                </span>
                              )}
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-sm">
                            <p className="text-xs break-all">{row.lastError}</p>
                            {row.state === "failed" && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Children have been released back to candidates. Re-initiate the merge from the section above.
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
