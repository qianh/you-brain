import { Icon, type IconName } from "./icons.js";

export function EmptyState({ title, icon = "inbox" }: { title: string; icon?: IconName }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <p>{title}</p>
    </div>
  );
}
