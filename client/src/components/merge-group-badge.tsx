import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { MergeGroupDialog } from "./merge-group-dialog";
import { GitMerge } from "lucide-react";

interface MergeGroupBadgeProps {
  shipmentId: string;
  mergeGroupId: number;
}

interface MergeGroupByShipmentResponse {
  group: {
    id: number;
    state: string;
    memberCount: number;
  } | null;
  role: string | null;
}

export function MergeGroupBadge({ shipmentId, mergeGroupId }: MergeGroupBadgeProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data } = useQuery<MergeGroupByShipmentResponse>({
    queryKey: ['/api/merge-groups/by-shipment', shipmentId],
    enabled: !!mergeGroupId,
  });

  if (!data?.group) return null;

  const { state, memberCount } = data.group;
  const isComplete = state === 'merge_complete';

  const badgeClasses = isComplete
    ? "border-green-600 text-green-700 dark:text-green-400"
    : "border-amber-500 text-amber-600 dark:text-amber-400";

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        data-testid={`button-merge-group-${shipmentId}`}
      >
        <Badge
          variant="outline"
          className={`text-xs px-1.5 py-0 cursor-pointer gap-1 ${badgeClasses}`}
          data-testid={`badge-merge-group-${shipmentId}`}
        >
          <GitMerge className="h-3 w-3" />
          ({memberCount})
        </Badge>
      </button>
      <MergeGroupDialog
        groupId={data.group.id}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
