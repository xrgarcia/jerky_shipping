import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HIDDEN_DISPLAY_TAGS, TAG_COLORS, TAG_PRIORITY } from "@shared/constants";

interface ShipmentTagBadgesProps {
  tags: (string | { name: string })[];
  maxVisible?: number;
  testIdPrefix?: string;
}

export function ShipmentTagBadges({ tags, maxVisible = 4, testIdPrefix }: ShipmentTagBadgesProps) {
  const tagNames = tags.map(t => typeof t === 'string' ? t : t.name);

  const displayTags = tagNames.filter(t => !HIDDEN_DISPLAY_TAGS.has(t));
  if (displayTags.length === 0) {
    return <span className="text-muted-foreground/50">-</span>;
  }

  const sortedTags = [...displayTags].sort((a, b) => {
    const diff = (TAG_PRIORITY[a] ?? 50) - (TAG_PRIORITY[b] ?? 50);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  return (
    <div className="flex flex-wrap gap-1" data-testid={testIdPrefix ? `tags-${testIdPrefix}` : undefined}>
      {sortedTags.slice(0, maxVisible).map((tag, idx) => {
        const colors = TAG_COLORS[tag];
        return (
          <Badge
            key={idx}
            variant="outline"
            className={`text-xs px-1.5 py-0 ${colors ? `${colors.bg} ${colors.text} ${colors.border}` : ''}`}
          >
            {tag}
          </Badge>
        );
      })}
      {sortedTags.length > maxVisible && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button">
              <Badge variant="secondary" className="text-xs px-1.5 py-0 cursor-pointer">
                +{sortedTags.length - maxVisible}
              </Badge>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <div className="flex flex-col gap-1">
              {sortedTags.slice(maxVisible).map((tag, idx) => {
                const colors = TAG_COLORS[tag];
                return (
                  <Badge
                    key={idx}
                    variant="outline"
                    className={`text-xs px-1.5 py-0 ${colors ? `${colors.bg} ${colors.text} ${colors.border}` : ''}`}
                  >
                    {tag}
                  </Badge>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
