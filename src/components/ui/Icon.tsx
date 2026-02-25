import React from 'react';
import {
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Minus,
  Square,
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
  GitMerge,
  GitCompare,
  Terminal,
  MessageSquare,
  MessageCircle,
  Check,
  X,
  Loader2,
  Code2,
  Layers,
  AlertCircle,
  Clock,
  MoreHorizontal,
  MoreVertical,
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
  Palette,
  Cpu,
  User,
  Download,
  RotateCcw,
  Edit2,
  Trash2,
  Eye,
  EyeOff,
  HardDrive,
  Cloud,
  Copy,
  Play,
  Pause,
  Circle,
  CircleDot,
  CheckCircle,
  Lock,
  Unlock,
  Pin,
  PinOff,
  Archive,
  Compass,
  Map,
  Network,
  FolderGit2,
  Upload,
  Link,
  Clipboard,
  Camera,
  LayoutGrid,
  RefreshCw,
  Share,
  Paperclip,
  PlusSquare,
  Image,
  Flag,
  Target,
  Milestone,
  Moon,
  Sun,
  Server,
  Database,
  ArrowLeft,
  Globe,
  ExternalLink,
  BookOpen,
  Expand,
} from 'lucide-react';

export type IconName =
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'minus'
  | 'maximize'
  | 'square'
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
  | 'git-merge'
  | 'git-compare'
  | 'terminal'
  | 'message-square'
  | 'message-circle'
  | 'check'
  | 'x'
  | 'loader'
  | 'code'
  | 'layers'
  | 'alert-circle'
  | 'clock'
  | 'more-horizontal'
  | 'more-vertical'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'panel-right-close'
  | 'panel-right-open'
  | 'file-code'
  | 'file-text'
  | 'palette'
  | 'arrow-up'
  | 'moon'
  | 'sun'
  | 'server'
  | 'database'
  | 'arrow-left'
  | 'arrow-up-right'
  | 'arrow-down-right'
  | 'zap'
  | 'shield'
  | 'tool'
  | 'cpu'
  | 'user'
  | 'download'
  | 'rotate-ccw'
  | 'edit'
  | 'trash'
  | 'eye'
  | 'eye-off'
  | 'hard-drive'
  | 'cloud'
  | 'copy'
  | 'play'
  | 'pause'
  | 'circle'
  | 'circle-dot'
  | 'check-circle'
  | 'lock'
  | 'unlock'
  | 'pin'
  | 'pin-off'
  | 'archive'
  | 'compass'
  | 'map'
  | 'network'
  | 'folder-git-2'
  | 'upload'
  | 'link'
  | 'clipboard'
  | 'camera'
  | 'layout-grid'
  | 'refresh-cw'
  | 'share'
  | 'paperclip'
  | 'plus-square'
  | 'image'
  | 'flag'
  | 'target'
  | 'milestone'
  | 'globe'
  | 'external-link'
  | 'book-open'
  | 'expand';

interface IconProps {
  name: IconName;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

const iconMap: Record<IconName, React.ComponentType<{ size?: number | string; className?: string; style?: React.CSSProperties }>> = {
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'minus': Minus,
  'maximize': Square,
  'square': Square,
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
  'git-merge': GitMerge,
  'git-compare': GitCompare,
  'terminal': Terminal,
  'message-square': MessageSquare,
  'message-circle': MessageCircle,
  'check': Check,
  'x': X,
  'loader': Loader2,
  'code': Code2,
  'layers': Layers,
  'alert-circle': AlertCircle,
  'clock': Clock,
  'more-horizontal': MoreHorizontal,
  'more-vertical': MoreVertical,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  'panel-right-close': PanelRightClose,
  'panel-right-open': PanelRightOpen,
  'file-code': FileCode,
  'file-text': FileText,
  'palette': Palette,
  'arrow-up': ArrowUp,
  'moon': Moon,
  'sun': Sun,
  'server': Server,
  'database': Database,
  'arrow-left': ArrowLeft,
  'arrow-up-right': ArrowUpRight,
  'arrow-down-right': ArrowDownRight,
  'zap': Zap,
  'shield': Shield,
  'tool': Wrench,
  'cpu': Cpu,
  'user': User,
  'download': Download,
  'rotate-ccw': RotateCcw,
  'edit': Edit2,
  'trash': Trash2,
  'eye': Eye,
  'eye-off': EyeOff,
  'hard-drive': HardDrive,
  'cloud': Cloud,
  'copy': Copy,
  'play': Play,
  'pause': Pause,
  'circle': Circle,
  'circle-dot': CircleDot,
  'check-circle': CheckCircle,
  'lock': Lock,
  'unlock': Unlock,
  'pin': Pin,
  'pin-off': PinOff,
  'archive': Archive,
  'compass': Compass,
  'map': Map,
  'network': Network,
  'folder-git-2': FolderGit2,
  'upload': Upload,
  'link': Link,
  'clipboard': Clipboard,
  'camera': Camera,
  'layout-grid': LayoutGrid,
  'refresh-cw': RefreshCw,
  'share': Share,
  'paperclip': Paperclip,
  'plus-square': PlusSquare,
  'image': Image,
  'flag': Flag,
  'target': Target,
  'milestone': Milestone,
  'globe': Globe,
  'external-link': ExternalLink,
  'book-open': BookOpen,
  'expand': Expand,
};

export const Icon: React.FC<IconProps> = ({ name, size = 16, className, style }) => {
  const IconComponent = iconMap[name];
  if (!IconComponent) return null;

  return <IconComponent size={size} className={className} style={style} />;
};
