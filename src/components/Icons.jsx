import {
  Clock3,
  Copy,
  DoorOpen,
  Link2,
  NotebookPen,
  SlidersHorizontal,
  UserRoundX,
  Users,
} from "lucide-react";

const iconProps = {
  "aria-hidden": true,
  size: 18,
  strokeWidth: 1.85,
};

export function SettingsIcon() {
  return <SlidersHorizontal {...iconProps} />;
}

export function CopyIcon() {
  return <Copy {...iconProps} />;
}

export function TimerIcon() {
  return <Clock3 {...iconProps} />;
}

export function ActivityIcon() {
  return <NotebookPen {...iconProps} />;
}

export function TeamIcon() {
  return <Users {...iconProps} />;
}

export function LeaveIcon() {
  return <DoorOpen {...iconProps} />;
}

export function KickIcon() {
  return <UserRoundX {...iconProps} />;
}

export function LinkIcon() {
  return <Link2 {...iconProps} />;
}
