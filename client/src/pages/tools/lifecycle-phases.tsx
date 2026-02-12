import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow, format } from "date-fns";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUpDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  Eye,
  Inbox,
  Search,
  Layers,
  Package,
  RefreshCw,
  RotateCcw,
  Skull,
  Truck,
  XCircle,
  Zap,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

type PhaseCount = {
  lifecycle_phase: string;
  decision_subphase: string | null;
  count: number;
};

type WorkerStatus = {
  running: boolean;
  shuttingDown: boolean;
  processedCount: number;
  sideEffectTriggeredCount: number;
  queueLength: number;
  inflightCount: number;
  lastPollTime: string | null;
  recentTransitions: Array<{
    timestamp: string;
    orderNumber: string;
    shipmentId: string;
    previousPhase: string | null;
    previousSubphase: string | null;
    newPhase: string;
    newSubphase: string | null;
    changed: boolean;
    reason: string;
    sideEffectTriggered: string | null;
    sideEffectResult: "success" | "failed" | "skipped" | null;
  }>;
  errorCount: number;
  lastErrorMessage: string | null;
  lastErrorTime: string | null;
};

const PHASE_META: Record<
  string,
  { label: string; description: string; colorClass: string; category: string }
> = {
  ready_to_fulfill: {
    label: "Ready to Fulfill",
    description: "On hold, waiting to be released (MOVE OVER tag)",
    colorClass: "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700",
    category: "pre",
  },
  ready_to_session: {
    label: "Ready to Session",
    description: "Pending, ready for session creation",
    colorClass: "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800",
    category: "pre",
  },
  fulfillment_prep: {
    label: "Fulfillment Prep",
    description: "Hydration, fingerprinting, packaging, rate check, sessioning",
    colorClass: "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800",
    category: "decision",
  },
  ready_for_skuvault: {
    label: "Ready for SkuVault",
    description: "Local session built, waiting for SkuVault wave picking",
    colorClass: "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
    category: "active",
  },
  ready_to_pick: {
    label: "Ready to Pick",
    description: "Session in SkuVault, waiting to start",
    colorClass: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700",
    category: "active",
  },
  picking: {
    label: "Picking",
    description: "Actively being picked",
    colorClass: "bg-green-200 dark:bg-green-900/40 border-green-400 dark:border-green-600",
    category: "active",
  },
  packing_ready: {
    label: "Packing Ready",
    description: "Picking complete, ready for packing",
    colorClass: "bg-teal-100 dark:bg-teal-900/30 border-teal-300 dark:border-teal-700",
    category: "post",
  },
  on_dock: {
    label: "On Dock",
    description: "Labeled, waiting for carrier pickup",
    colorClass: "bg-teal-200 dark:bg-teal-900/40 border-teal-400 dark:border-teal-600",
    category: "post",
  },
  in_transit: {
    label: "In Transit",
    description: "Package in transit",
    colorClass: "bg-emerald-100 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700",
    category: "shipping",
  },
  delivered: {
    label: "Delivered",
    description: "Terminal state",
    colorClass: "bg-emerald-200 dark:bg-emerald-900/40 border-emerald-400 dark:border-emerald-600",
    category: "shipping",
  },
  cancelled: {
    label: "Cancelled",
    description: "Order cancelled - terminal state",
    colorClass: "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
    category: "terminal",
  },
  problem: {
    label: "Problem",
    description: "Shipment problem (SP/UN/EX) - customer service issue",
    colorClass: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700",
    category: "terminal",
  },
  picking_issues: {
    label: "Picking Issues",
    description: "Exception requiring attention",
    colorClass: "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700",
    category: "issue",
  },
};

const SUBPHASE_META: Record<
  string,
  { label: string; description: string }
> = {
  needs_hydration: {
    label: "Hydration",
    description: "QC items not yet created \u2014 automated step",
  },
  needs_categorization: {
    label: "Categorize",
    description: "SKUs not yet assigned to geometry collections",
  },
  needs_fingerprint: {
    label: "Fingerprint",
    description: "Fingerprint not yet calculated",
  },
  needs_packaging: {
    label: "Packaging",
    description: "No packaging type mapping",
  },
  needs_rate_check: {
    label: "Rate Check",
    description: "Rate analysis pending",
  },
  needs_session: {
    label: "Build Sessions",
    description: "All prep complete — ready to be grouped into a fulfillment session batch for warehouse picking",
  },
};

const MAIN_FLOW_ORDER = [
  "ready_to_fulfill",
  "ready_to_session",
  "fulfillment_prep",
  "ready_for_skuvault",
  "ready_to_pick",
  "picking",
  "packing_ready",
  "on_dock",
  "in_transit",
  "delivered",
  "cancelled",
  "problem",
];

const SUBPHASE_ORDER = [
  "needs_hydration",
  "needs_categorization",
  "needs_fingerprint",
  "needs_packaging",
  "needs_rate_check",
  "needs_session",
];

function getPhaseCount(
  counts: PhaseCount[] | undefined,
  phase: string,
  subphase?: string | null
): number {
  if (!counts) return 0;
  if (subphase) {
    const match = counts.find(
      (c) => c.lifecycle_phase === phase && c.decision_subphase === subphase
    );
    return match?.count ?? 0;
  }
  return counts
    .filter((c) => c.lifecycle_phase === phase)
    .reduce((sum, c) => sum + c.count, 0);
}

function formatPhase(phase: string | null, subphase: string | null): string {
  if (!phase) return "-";
  const meta = PHASE_META[phase];
  const label = meta?.label ?? phase;
  if (subphase) {
    const sub = SUBPHASE_META[subphase];
    return `${label} / ${sub?.label ?? subphase}`;
  }
  return label;
}

function PhaseBox({
  phase,
  count,
  isLoading,
}: {
  phase: string;
  count: number;
  isLoading: boolean;
}) {
  const meta = PHASE_META[phase];
  if (!meta) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`border rounded-md p-3 min-w-[160px] text-center ${meta.colorClass}`}
          data-testid={`phase-box-${phase}`}
        >
          <div className="text-sm font-medium text-foreground">{meta.label}</div>
          <div className="mt-1">
            {isLoading ? (
              <Skeleton className="h-5 w-10 mx-auto" />
            ) : (
              <Badge variant="secondary" className="no-default-active-elevate" data-testid={`phase-count-${phase}`}>
                {count}
              </Badge>
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{meta.label}</p>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function SubphaseBox({
  subphase,
  count,
  isLoading,
}: {
  subphase: string;
  count: number;
  isLoading: boolean;
}) {
  const meta = SUBPHASE_META[subphase];
  if (!meta) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="border border-blue-300 dark:border-blue-700 bg-blue-100 dark:bg-blue-900/40 rounded-md p-2 min-w-[100px] text-center"
          data-testid={`subphase-box-${subphase}`}
        >
          <div className="text-xs font-medium text-foreground">{meta.label}</div>
          <div className="mt-1">
            {isLoading ? (
              <Skeleton className="h-4 w-8 mx-auto" />
            ) : (
              <Badge variant="secondary" className="no-default-active-elevate text-xs" data-testid={`subphase-count-${subphase}`}>
                {count}
              </Badge>
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">{meta.label}</p>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function DownArrow() {
  return (
    <div className="flex justify-center py-1">
      <ArrowDown className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}

function RightArrow() {
  return (
    <div className="flex items-center px-1">
      <ArrowRight className="h-3 w-3 text-blue-400 dark:text-blue-500" />
    </div>
  );
}

function BranchArrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <ArrowDown className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}

function StateMachineTab({
  counts,
  isLoading,
}: {
  counts: PhaseCount[] | undefined;
  isLoading: boolean;
}) {
  const issueCount = getPhaseCount(counts, "picking_issues");

  return (
    <div className="flex flex-col items-center gap-0 py-4" data-testid="state-machine-view">
      {/* ready_to_fulfill */}
      <PhaseBox phase="ready_to_fulfill" count={getPhaseCount(counts, "ready_to_fulfill")} isLoading={isLoading} />
      <DownArrow />

      {/* ready_to_session */}
      <PhaseBox phase="ready_to_session" count={getPhaseCount(counts, "ready_to_session")} isLoading={isLoading} />
      <DownArrow />

      {/* fulfillment_prep expanded (includes ready_for_skuvault) */}
      <div
        className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 rounded-md p-3"
        data-testid="phase-box-fulfillment_prep"
      >
        <div className="text-sm font-medium text-center mb-2 text-foreground">
          Fulfillment Prep
          <span className="ml-2">
            {isLoading ? (
              <Skeleton className="inline-block h-4 w-8" />
            ) : (
              <Badge variant="secondary" className="no-default-active-elevate" data-testid="phase-count-fulfillment_prep">
                {getPhaseCount(counts, "fulfillment_prep")}
              </Badge>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 justify-center">
          {SUBPHASE_ORDER.map((sub, i) => (
            <div key={sub} className="flex items-center gap-1">
              <SubphaseBox
                subphase={sub}
                count={getPhaseCount(counts, "fulfillment_prep", sub)}
                isLoading={isLoading}
              />
              {i < SUBPHASE_ORDER.length - 1 && (
                <RightArrow />
              )}
            </div>
          ))}
        </div>
      </div>

      <DownArrow />

      {/* ready_for_skuvault */}
      <PhaseBox phase="ready_for_skuvault" count={getPhaseCount(counts, "ready_for_skuvault")} isLoading={isLoading} />
      <DownArrow />

      {/* ready_to_pick */}
      <PhaseBox phase="ready_to_pick" count={getPhaseCount(counts, "ready_to_pick")} isLoading={isLoading} />
      <DownArrow />

      {/* picking + picking_issues branch */}
      <div className="flex flex-wrap items-start gap-8 justify-center">
        <div className="flex flex-col items-center gap-0">
          <PhaseBox phase="picking" count={getPhaseCount(counts, "picking")} isLoading={isLoading} />
        </div>
        <div className="flex flex-col items-center gap-0">
          <BranchArrow label="issues" />
          <PhaseBox phase="picking_issues" count={issueCount} isLoading={isLoading} />
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <ArrowDown className="h-3 w-3 rotate-180" />
            <span>resolve</span>
          </div>
        </div>
      </div>

      <DownArrow />

      {/* packing_ready */}
      <PhaseBox phase="packing_ready" count={getPhaseCount(counts, "packing_ready")} isLoading={isLoading} />
      <DownArrow />

      {/* on_dock */}
      <PhaseBox phase="on_dock" count={getPhaseCount(counts, "on_dock")} isLoading={isLoading} />
      <DownArrow />

      {/* in_transit */}
      <PhaseBox phase="in_transit" count={getPhaseCount(counts, "in_transit")} isLoading={isLoading} />
      <DownArrow />

      {/* Terminal states: delivered, cancelled, problem */}
      <div className="flex flex-wrap items-start gap-8 justify-center">
        <PhaseBox phase="delivered" count={getPhaseCount(counts, "delivered")} isLoading={isLoading} />
        <PhaseBox phase="cancelled" count={getPhaseCount(counts, "cancelled")} isLoading={isLoading} />
        <PhaseBox phase="problem" count={getPhaseCount(counts, "problem")} isLoading={isLoading} />
      </div>
    </div>
  );
}

function EventWorkerTab({
  workerStatus,
  workerLoading,
  counts,
  countsLoading,
}: {
  workerStatus: WorkerStatus | undefined;
  workerLoading: boolean;
  counts: PhaseCount[] | undefined;
  countsLoading: boolean;
}) {
  const [isRestarting, setIsRestarting] = useState(false);
  const { toast } = useToast();

  return (
    <div className="space-y-4 py-4" data-testid="event-worker-view">
      {/* Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-worker-status">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Worker Status</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {workerLoading ? (
              <Skeleton className="h-6 w-20" />
            ) : workerStatus?.running ? (
              <Badge variant="default" className="no-default-active-elevate bg-green-600" data-testid="badge-worker-running">
                Running
              </Badge>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive" className="no-default-active-elevate" data-testid="badge-worker-stopped">
                  Stopped
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    setIsRestarting(true);
                    try {
                      await apiRequest('POST', '/api/operations/restart-lifecycle-worker');
                      queryClient.invalidateQueries({ queryKey: ["/api/lifecycle-worker-status"] });
                      toast({
                        title: "Worker Restarted",
                        description: "Lifecycle event worker has been restarted.",
                      });
                    } catch (err) {
                      toast({
                        title: "Failed to restart worker",
                        description: err instanceof Error ? err.message : "Unknown error",
                        variant: "destructive",
                      });
                    } finally {
                      setIsRestarting(false);
                    }
                  }}
                  disabled={isRestarting}
                  data-testid="button-restart-lifecycle-worker"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${isRestarting ? "animate-spin" : ""}`} />
                  {isRestarting ? "Restarting..." : "Restart"}
                </Button>
              </div>
            )}
            {workerStatus?.shuttingDown && (
              <p className="text-xs text-muted-foreground mt-1">Shutting down...</p>
            )}
            {workerStatus?.lastPollTime && (
              <p className="text-xs text-muted-foreground mt-1">
                Last poll: {formatDistanceToNow(new Date(workerStatus.lastPollTime), { addSuffix: true })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-queue-depth">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Queue Depth</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {workerLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold" data-testid="text-queue-length">
                  {workerStatus?.queueLength ?? 0}
                </div>
                <p className="text-xs text-muted-foreground">
                  {workerStatus?.inflightCount ?? 0} inflight
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-processed">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processed</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {workerLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold" data-testid="text-processed-count">
                  {workerStatus?.processedCount ?? 0}
                </div>
                <p className="text-xs text-muted-foreground">
                  {workerStatus?.sideEffectTriggeredCount ?? 0} side effects
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-errors">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Errors</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {workerLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-2xl font-bold" data-testid="text-error-count">
                  {workerStatus?.errorCount ?? 0}
                </div>
                {workerStatus?.lastErrorTime && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-xs text-muted-foreground truncate max-w-[180px] cursor-help">
                        {formatDistanceToNow(new Date(workerStatus.lastErrorTime), { addSuffix: true })}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="max-w-xs break-words">{workerStatus.lastErrorMessage}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Transitions Table */}
      <Card data-testid="card-recent-transitions">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Recent Transitions</CardTitle>
        </CardHeader>
        <CardContent>
          {workerLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : !workerStatus?.recentTransitions?.length ? (
            <p className="text-sm text-muted-foreground">No recent transitions</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Order #</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Changed</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Side Effect</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workerStatus.recentTransitions.slice(0, 20).map((t, i) => (
                    <TableRow key={i} data-testid={`row-transition-${i}`}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(new Date(t.timestamp), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="font-mono text-xs" data-testid={`text-order-${i}`}>
                        {t.orderNumber}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatPhase(t.previousPhase, t.previousSubphase)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatPhase(t.newPhase, t.newSubphase)}
                      </TableCell>
                      <TableCell>
                        {t.changed ? (
                          <Badge variant="default" className="no-default-active-elevate bg-green-600 text-xs">
                            Yes
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="no-default-active-elevate text-xs">
                            No
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate" title={t.reason}>
                        {t.reason}
                      </TableCell>
                      <TableCell className="text-xs">
                        {t.sideEffectTriggered ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help">
                                {t.sideEffectResult === "success" && (
                                  <Badge variant="default" className="no-default-active-elevate bg-green-600 text-xs">
                                    {t.sideEffectTriggered}
                                  </Badge>
                                )}
                                {t.sideEffectResult === "failed" && (
                                  <Badge variant="destructive" className="no-default-active-elevate text-xs">
                                    {t.sideEffectTriggered}
                                  </Badge>
                                )}
                                {t.sideEffectResult === "skipped" && (
                                  <Badge variant="secondary" className="no-default-active-elevate text-xs">
                                    {t.sideEffectTriggered}
                                  </Badge>
                                )}
                                {!t.sideEffectResult && (
                                  <Badge variant="outline" className="no-default-active-elevate text-xs">
                                    {t.sideEffectTriggered}
                                  </Badge>
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Result: {t.sideEffectResult ?? "pending"}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase Distribution Bar Chart */}
      <Card data-testid="card-phase-distribution">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Phase Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          {countsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <PhaseDistributionChart counts={counts} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PhaseDistributionChart({ counts }: { counts: PhaseCount[] | undefined }) {
  const phaseTotals = MAIN_FLOW_ORDER.map((phase) => ({
    phase,
    label: PHASE_META[phase]?.label ?? phase,
    count: getPhaseCount(counts, phase),
    colorClass: PHASE_META[phase]?.colorClass ?? "",
  }));

  const pickingIssues = {
    phase: "picking_issues",
    label: PHASE_META["picking_issues"]?.label ?? "Picking Issues",
    count: getPhaseCount(counts, "picking_issues"),
    colorClass: PHASE_META["picking_issues"]?.colorClass ?? "",
  };
  const all = [...phaseTotals, pickingIssues];
  const maxCount = Math.max(1, ...all.map((p) => p.count));

  return (
    <div className="space-y-2" data-testid="phase-distribution-bars">
      {all.map((p) => (
        <div key={p.phase} className="flex items-center gap-3">
          <div className="w-28 text-xs text-right text-muted-foreground truncate shrink-0">
            {p.label}
          </div>
          <div className="flex-1 h-5 bg-muted rounded-md overflow-hidden">
            <div
              className={`h-full rounded-md border ${p.colorClass}`}
              style={{ width: `${Math.max(p.count > 0 ? 2 : 0, (p.count / maxCount) * 100)}%` }}
              data-testid={`bar-${p.phase}`}
            />
          </div>
          <div className="w-10 text-xs text-right font-mono" data-testid={`bar-count-${p.phase}`}>
            {p.count}
          </div>
        </div>
      ))}
    </div>
  );
}

type WriteQueueJob = {
  id: number;
  shipmentId: string;
  patchPayload: Record<string, any>;
  reason: string;
  status: string;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  processedAt: string | null;
  completedAt: string | null;
  localShipmentId: string | null;
  callbackAction: string | null;
  orderNumber: string | null;
  httpStatusCode: number | null;
  httpResponse: any | null;
};

type WriteQueueStats = {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
};

type WriteQueueJobsResponse = {
  jobs: WriteQueueJob[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  reasons: string[];
};

const STATUS_BADGE_MAP: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; className?: string; label: string }> = {
  queued: { variant: "secondary", label: "Queued" },
  processing: { variant: "default", className: "bg-blue-600", label: "Processing" },
  completed: { variant: "default", className: "bg-green-600", label: "Completed" },
  failed: { variant: "destructive", label: "Failed" },
  dead_letter: { variant: "destructive", className: "bg-red-800 dark:bg-red-900", label: "Dead Letter" },
};

type FeatureFlag = {
  id: number;
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

function PackageUpdatesTab() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [sortBy, setSortBy] = useState("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderSearchDebounced, setOrderSearchDebounced] = useState("");
  const [responseDialogJob, setResponseDialogJob] = useState<WriteQueueJob | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const timeout = setTimeout(() => {
      setOrderSearchDebounced(orderSearch);
      setPage(1);
    }, 400);
    return () => clearTimeout(timeout);
  }, [orderSearch]);

  const { data: featureFlags, isLoading: featureFlagsLoading } = useQuery<FeatureFlag[]>({
    queryKey: ["/api/operations/feature-flags"],
  });

  const autoPackageSyncFlag = featureFlags?.find(f => f.key === "auto_package_sync");
  const isAutoPackageSyncEnabled = autoPackageSyncFlag?.enabled ?? false;

  const updateFeatureFlagMutation = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) => {
      return apiRequest('PUT', `/api/operations/feature-flags/${key}`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/operations/feature-flags"] });
      toast({
        title: "Feature flag updated",
        description: "The setting has been saved.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update feature flag",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const { data: stats, isLoading: statsLoading } = useQuery<WriteQueueStats>({
    queryKey: ["/api/write-queue/stats"],
    refetchInterval: 5000,
  });

  const { data: jobsData, isLoading: jobsLoading } = useQuery<WriteQueueJobsResponse>({
    queryKey: ["/api/write-queue/jobs", page, statusFilter, reasonFilter, sortBy, sortOrder, orderSearchDebounced],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "25",
        sortBy,
        sortOrder,
      });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (reasonFilter !== "all") params.set("reason", reasonFilter);
      if (orderSearchDebounced.trim()) params.set("orderNumber", orderSearchDebounced.trim());
      const res = await fetch(`/api/write-queue/jobs?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch write queue jobs");
      return res.json();
    },
    refetchInterval: 5000,
  });

  const totalJobs = (stats?.queued ?? 0) + (stats?.processing ?? 0) + (stats?.completed ?? 0) + (stats?.failed ?? 0) + (stats?.deadLetter ?? 0);

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortOrder(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("desc");
    }
    setPage(1);
  }

  function SortableHeader({ column, children }: { column: string; children: React.ReactNode }) {
    const isActive = sortBy === column;
    return (
      <TableHead
        className="cursor-pointer select-none"
        onClick={() => toggleSort(column)}
        data-testid={`sort-${column}`}
      >
        <div className="flex items-center gap-1">
          {children}
          <ArrowUpDown className={`h-3 w-3 ${isActive ? "text-foreground" : "text-muted-foreground/50"}`} />
        </div>
      </TableHead>
    );
  }

  return (
    <div className="space-y-4 py-4" data-testid="package-updates-view">
      <Card data-testid="card-auto-package-sync">
        <CardContent className="pt-4 pb-4">
          {featureFlagsLoading ? (
            <Skeleton className="h-6 w-full" />
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 flex-1">
                <p className="text-sm font-medium">Auto Package Sync</p>
                <p className="text-sm text-muted-foreground">
                  Automatically sync package dimensions to ShipStation when fingerprints with packaging types are assigned
                </p>
                {autoPackageSyncFlag?.updatedBy && (
                  <p className="text-xs text-muted-foreground">
                    Last updated by {autoPackageSyncFlag.updatedBy}
                  </p>
                )}
              </div>
              <Switch
                data-testid="switch-auto_package_sync"
                checked={isAutoPackageSyncEnabled}
                disabled={updateFeatureFlagMutation.isPending}
                onCheckedChange={(checked) => {
                  updateFeatureFlagMutation.mutate({ key: "auto_package_sync", enabled: checked });
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card data-testid="card-wq-total">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold" data-testid="text-wq-total">{totalJobs}</div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-wq-queued">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Queued</CardTitle>
            <Inbox className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <>
                <div className="text-2xl font-bold" data-testid="text-wq-queued">{stats?.queued ?? 0}</div>
                <p className="text-xs text-muted-foreground">{stats?.processing ?? 0} processing</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-wq-completed">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold" data-testid="text-wq-completed">{stats?.completed ?? 0}</div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-wq-failed">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold" data-testid="text-wq-failed">{stats?.failed ?? 0}</div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-wq-dead-letter">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Dead Letter</CardTitle>
            <Skull className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold" data-testid="text-wq-dead-letter">{stats?.deadLetter ?? 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-wq-jobs">
        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 flex-wrap">
          <CardTitle className="text-sm font-medium">Queue Jobs</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search order..."
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                className="pl-8 w-[180px]"
                data-testid="input-order-search"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="dead_letter">Dead Letter</SelectItem>
              </SelectContent>
            </Select>

            <Select value={reasonFilter} onValueChange={(v) => { setReasonFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[160px]" data-testid="select-reason-filter">
                <SelectValue placeholder="Reason" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Reasons</SelectItem>
                {jobsData?.reasons?.map((r) => (
                  <SelectItem key={r} value={r}>{r.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/write-queue/jobs"] });
                queryClient.invalidateQueries({ queryKey: ["/api/write-queue/stats"] });
              }}
              data-testid="button-refresh-wq"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : !jobsData?.jobs?.length ? (
            <p className="text-sm text-muted-foreground">No jobs in the write queue</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHeader column="id">ID</SortableHeader>
                      <TableHead>Order</TableHead>
                      <TableHead>Shipment ID</TableHead>
                      <TableHead>Reason</TableHead>
                      <SortableHeader column="status">Status</SortableHeader>
                      <TableHead>HTTP</TableHead>
                      <SortableHeader column="retryCount">Retries</SortableHeader>
                      <TableHead>Error</TableHead>
                      <SortableHeader column="createdAt">Created</SortableHeader>
                      <SortableHeader column="completedAt">Completed</SortableHeader>
                      <TableHead>Resp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobsData.jobs.map((job) => {
                      const statusMeta = STATUS_BADGE_MAP[job.status] ?? { variant: "outline" as const, label: job.status };
                      return (
                        <TableRow key={job.id} data-testid={`row-wq-job-${job.id}`}>
                          <TableCell className="font-mono text-xs" data-testid={`text-wq-id-${job.id}`}>
                            #{job.id}
                          </TableCell>
                          <TableCell className="text-xs font-mono whitespace-nowrap" data-testid={`text-wq-order-${job.id}`}>
                            {job.orderNumber ?? <span className="text-muted-foreground">-</span>}
                          </TableCell>
                          <TableCell className="font-mono text-xs max-w-[140px] truncate" title={job.shipmentId}>
                            {job.shipmentId}
                          </TableCell>
                          <TableCell className="text-xs">
                            <Badge variant="outline" className="no-default-active-elevate text-xs">
                              {job.reason.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={statusMeta.variant}
                              className={`no-default-active-elevate text-xs ${statusMeta.className ?? ""}`}
                            >
                              {statusMeta.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs font-mono text-center" data-testid={`text-wq-http-${job.id}`}>
                            {job.httpStatusCode != null ? (
                              <Badge
                                variant={job.httpStatusCode >= 200 && job.httpStatusCode < 300 ? "outline" : "destructive"}
                                className="no-default-active-elevate text-xs font-mono"
                              >
                                {job.httpStatusCode}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-center">
                            {job.retryCount}/{job.maxRetries}
                          </TableCell>
                          <TableCell className="text-xs max-w-[200px]">
                            {job.lastError ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-destructive truncate block max-w-[200px] cursor-help">
                                    {job.lastError}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="max-w-sm">
                                  <p className="break-words text-xs">{job.lastError}</p>
                                  {job.nextRetryAt && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      Next retry: {format(new Date(job.nextRetryAt), "MMM d, h:mm:ss a")}
                                    </p>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {job.completedAt
                              ? formatDistanceToNow(new Date(job.completedAt), { addSuffix: true })
                              : job.processedAt
                                ? <span className="text-blue-500">processing...</span>
                                : "-"
                            }
                          </TableCell>
                          <TableCell>
                            {job.httpResponse != null ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setResponseDialogJob(job)}
                                data-testid={`button-wq-response-${job.id}`}
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {jobsData.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between gap-2 pt-4">
                  <p className="text-xs text-muted-foreground">
                    Showing {((page - 1) * 25) + 1}-{Math.min(page * 25, jobsData.pagination.total)} of {jobsData.pagination.total}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={page <= 1}
                      onClick={() => setPage(p => p - 1)}
                      data-testid="button-wq-prev"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm px-2">
                      {page} / {jobsData.pagination.totalPages}
                    </span>
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={page >= jobsData.pagination.totalPages}
                      onClick={() => setPage(p => p + 1)}
                      data-testid="button-wq-next"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={responseDialogJob !== null} onOpenChange={(open) => { if (!open) setResponseDialogJob(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col" data-testid="dialog-wq-response">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">
              Job #{responseDialogJob?.id} Response
              {responseDialogJob?.httpStatusCode != null && (
                <Badge
                  variant={responseDialogJob.httpStatusCode >= 200 && responseDialogJob.httpStatusCode < 300 ? "outline" : "destructive"}
                  className="no-default-active-elevate text-xs font-mono ml-2"
                >
                  {responseDialogJob.httpStatusCode}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {responseDialogJob?.orderNumber && <span className="font-mono">{responseDialogJob.orderNumber}</span>}
              {responseDialogJob?.orderNumber && responseDialogJob?.shipmentId && " / "}
              {responseDialogJob?.shipmentId && <span className="font-mono">{responseDialogJob.shipmentId}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-auto flex-1 rounded-md border bg-muted/50 p-4">
            <pre className="text-xs font-mono whitespace-pre-wrap break-words" data-testid="text-wq-response-json">
              {responseDialogJob?.httpResponse != null
                ? JSON.stringify(responseDialogJob.httpResponse, null, 2)
                : "No response data"}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function LifecyclePhases() {
  const { data: countsData, isLoading: countsLoading } = useQuery<{
    counts: PhaseCount[];
  }>({
    queryKey: ["/api/lifecycle-phase-counts"],
    refetchInterval: 30000,
  });

  const { data: workerData, isLoading: workerLoading } = useQuery<WorkerStatus>({
    queryKey: ["/api/lifecycle-worker-status"],
    refetchInterval: 5000,
  });

  return (
    <div className="p-4 space-y-4" data-testid="page-lifecycle-phases">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">
          Lifecycle Phases
        </h1>
        <p className="text-sm text-muted-foreground">
          Visualize the shipment lifecycle state machine and monitor the event worker
        </p>
      </div>

      <Tabs defaultValue="state-machine" data-testid="tabs-lifecycle">
        <TabsList data-testid="tabs-list">
          <TabsTrigger value="state-machine" data-testid="tab-state-machine">
            State Machine
          </TabsTrigger>
          <TabsTrigger value="event-worker" data-testid="tab-event-worker">
            Event Worker
          </TabsTrigger>
          <TabsTrigger value="package-updates" data-testid="tab-package-updates">
            Package Updates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="state-machine">
          <StateMachineTab counts={countsData?.counts} isLoading={countsLoading} />
        </TabsContent>

        <TabsContent value="event-worker">
          <EventWorkerTab
            workerStatus={workerData}
            workerLoading={workerLoading}
            counts={countsData?.counts}
            countsLoading={countsLoading}
          />
        </TabsContent>

        <TabsContent value="package-updates">
          <PackageUpdatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
