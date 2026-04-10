import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";

interface MergeGroupMember {
  id: number;
  shipmentId: string;
  orderNumber: string;
  role: string | null;
  originalItemCount: number;
  originalItems: any;
  shipmentStatus: string | null;
  lifecyclePhase: string | null;
  trackingNumber: string | null;
  sessionId: string | null;
  currentItemCount: number;
  currentTotalQuantity: number;
}

interface MergeGroupDetail {
  id: number;
  groupKey: string;
  state: string;
  memberCount: number;
  parentShipmentId: string | null;
  matchEmail: string;
  matchAddress: string;
  matchCity: string;
  matchState: string;
  matchZip: string;
  detectedAt: string;
}

interface MergeGroupDialogProps {
  groupId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getStateBadge(state: string) {
  switch (state) {
    case 'detected':
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400" data-testid="badge-merge-state">Detected</Badge>;
    case 'merge_started':
      return <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400" data-testid="badge-merge-state">Merge Started</Badge>;
    case 'merge_complete':
      return <Badge variant="outline" className="border-green-600 text-green-700 dark:text-green-400" data-testid="badge-merge-state">Merge Complete</Badge>;
    case 'all_sessioned':
      return <Badge variant="outline" className="border-blue-500 text-blue-600 dark:text-blue-400" data-testid="badge-merge-state">All Sessioned</Badge>;
    default:
      return <Badge variant="outline" data-testid="badge-merge-state">{state}</Badge>;
  }
}

function getRoleBadge(role: string | null) {
  switch (role) {
    case 'parent':
      return <Badge variant="outline" className="border-green-600 text-green-700 dark:text-green-400" data-testid="badge-merge-role">parent</Badge>;
    case 'child':
      return <Badge variant="outline" className="border-red-500 text-red-600 dark:text-red-400" data-testid="badge-merge-role">child</Badge>;
    default:
      return <Badge variant="secondary" className="text-muted-foreground" data-testid="badge-merge-role">undetermined</Badge>;
  }
}

export function MergeGroupDialog({ groupId, open, onOpenChange }: MergeGroupDialogProps) {
  const { data, isLoading } = useQuery<{ group: MergeGroupDetail; members: MergeGroupMember[] }>({
    queryKey: ['/api/merge-groups', groupId],
    enabled: open && groupId !== null,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="dialog-merge-group">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap" data-testid="text-merge-group-title">
            Merge Group #{groupId}
            {data?.group && getStateBadge(data.group.state)}
          </DialogTitle>
          <DialogDescription>
            Orders shipping to the same address that may have been merged.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              {data.group.matchAddress}, {data.group.matchCity}, {data.group.matchState} {data.group.matchZip}
            </div>

            <ScrollArea className="max-h-[400px]">
              <table className="w-full text-sm" data-testid="table-merge-members">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 px-3">Order</th>
                    <th className="py-2 px-3">Role</th>
                    <th className="py-2 px-3">Items</th>
                    <th className="py-2 px-3">Qty</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Lifecycle</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((member) => (
                    <tr key={member.id} className="border-b last:border-0" data-testid={`row-merge-member-${member.shipmentId}`}>
                      <td className="py-2 px-3 font-mono">
                        <Link
                          href={`/shipments/${member.shipmentId}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`link-order-${member.orderNumber}`}
                          onClick={() => onOpenChange(false)}
                        >
                          {member.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 px-3">
                        {getRoleBadge(member.role)}
                      </td>
                      <td className="py-2 px-3 tabular-nums">
                        {member.currentItemCount}
                      </td>
                      <td className="py-2 px-3 tabular-nums">
                        {member.currentTotalQuantity}
                      </td>
                      <td className="py-2 px-3">
                        <span className="text-muted-foreground">{member.shipmentStatus || '—'}</span>
                      </td>
                      <td className="py-2 px-3">
                        <span className="text-muted-foreground">{member.lifecyclePhase || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {(() => {
                    const hasParent = data.members.some(m => m.role === "parent");
                    const membersForTotal = hasParent
                      ? data.members.filter(m => m.role !== "parent")
                      : data.members;
                    return (
                      <tr className="border-t font-medium">
                        <td className="py-2 px-3">Expected</td>
                        <td className="py-2 px-3"></td>
                        <td className="py-2 px-3 tabular-nums">
                          {membersForTotal.reduce((sum, m) => sum + m.originalItemCount, 0)}
                        </td>
                        <td className="py-2 px-3 tabular-nums">
                          {membersForTotal.reduce((sum, m) => {
                            const items = m.originalItems as Array<{ sku: string; quantity: number }>;
                            return sum + items.reduce((s, i) => s + i.quantity, 0);
                          }, 0)}
                        </td>
                        <td className="py-2 px-3"></td>
                        <td className="py-2 px-3"></td>
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
            </ScrollArea>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            No data available
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
