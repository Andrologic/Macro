import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  CheckSquare,
  List,
  ListTodo,
  Sparkles,
  FolderOpen,
  Folder,
  File,
  Plus,
  Search,
  Settings,
  GitBranch,
  GitCommit,
  Terminal,
  MessageSquare,
  Check,
  X,
  Loader2,
  Code2,
  Layers,
  AlertCircle,
  Clock,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  FileCode,
  FileText,
  ArrowUp,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Shield,
  Wrench,
  Cpu,
  User,
  Download,
} from 'lucide-react';

export type IconName =
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'check-square'
  | 'list-todo'
  | 'list'
  | 'sparkles'
  | 'folder-open'
  | 'folder'
  | 'file'
  | 'plus'
  | 'search'
  | 'settings'
  | 'git-branch'
  | 'git-commit'
  | 'terminal'
  | 'message-square'
  | 'check'
  | 'x'
  | 'loader'
  | 'code'
  | 'layers'
  | 'alert-circle'
  | 'clock'
  | 'more-horizontal'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'panel-right-close'
  | 'panel-right-open'
  | 'file-code'
  | 'file-text'
  | 'arrow-up'
  | 'arrow-up-right'
  | 'arrow-down-right'
  | 'zap'
  | 'shield'
  | 'tool'
  | 'cpu'
  | 'user'
  | 'download';

interface IconProps {
  name: IconName;
  size?: number | string;
  className?: string;
}

const iconMap: Record<IconName, React.ComponentType<{ size?: number | string; className?: string }>> = {
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'check-square': CheckSquare,
  'list-todo': ListTodo,
  'list': List,
  'sparkles': Sparkles,
  'folder-open': FolderOpen,
  'folder': Folder,
  'file': File,
  'plus': Plus,
  'search': Search,
  'settings': Settings,
  'git-branch': GitBranch,
  'git-commit': GitCommit,
  'terminal': Terminal,
  'message-square': MessageSquare,
  'check': Check,
  'x': X,
  'loader': Loader2,
  'code': Code2,
  'layers': Layers,
  'alert-circle': AlertCircle,
  'clock': Clock,
  'more-horizontal': MoreHorizontal,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  'panel-right-close': PanelRightClose,
  'panel-right-open': PanelRightOpen,
  'file-code': FileCode,
  'file-text': FileText,
  'arrow-up': ArrowUp,
  'arrow-up-right': ArrowUpRight,
  'arrow-down-right': ArrowDownRight,
  'zap': Zap,
  'shield': Shield,
  'tool': Wrench,
  'cpu': Cpu,
  'user': User,
  'download': Download,
};

export const Icon: React.FC<IconProps> = ({ name, size = 16, className }) => {
  const IconComponent = iconMap[name];
  if (!IconComponent) return null;

  return <IconComponent size={size} className={className} />;
};
