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
  History,
  Terminal,
  MessageSquare,
  MessageCircle,
  Bell,
  Check,
  X,
  Loader2,
  Code2,
  Layers,
  AlertCircle,
  CircleX,
  TriangleAlert,
  Clock,
  MoreHorizontal,
  MoreVertical,
  GripVertical,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  FileCode,
  FileText,
  ArrowDown,
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
  Undo2,
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
  FolderTree,
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
  Save,
  Split,
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
  | 'history'
  | 'terminal'
  | 'message-square'
  | 'message-circle'
  | 'message-circle-question'
  | 'bell'
  | 'check'
  | 'x'
  | 'loader'
  | 'code'
  | 'layers'
  | 'alert-circle'
  | 'circle-x'
  | 'triangle-alert'
  | 'clock'
  | 'more-horizontal'
  | 'more-vertical'
  | 'grip-vertical'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'panel-right-close'
  | 'panel-right-open'
  | 'file-code'
  | 'file-text'
  | 'palette'
  | 'arrow-down'
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
  | 'undo-2'
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
  | 'strategy'
  | 'compass'
  | 'map'
  | 'network'
  | 'folder-git-2'
  | 'folder-tree'
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
  | 'save'
  | 'split'
  | 'expand';

interface IconProps {
  name: IconName;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

const MessageCircleQuestionIcon: React.FC<{
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ size = 16, className, style }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    aria-hidden="true"
  >
    <path d="M8.5 18.2 4 21v-5.2A7.9 7.9 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8c-1.2 0-2.4-.2-3.5-.6Z" />
    <path d="M10.2 9.4a2 2 0 1 1 3.7 1c-.5.9-1.5 1.3-1.9 2.1-.2.4-.3.8-.3 1.2" />
    <path d="M11.7 16.8h.1" />
  </svg>
);

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
  'history': History,
  'terminal': Terminal,
  'message-square': MessageSquare,
  'message-circle': MessageCircle,
  'message-circle-question': MessageCircleQuestionIcon,
  'bell': Bell,
  'check': Check,
  'x': X,
  'loader': Loader2,
  'code': Code2,
  'layers': Layers,
  'alert-circle': AlertCircle,
  'circle-x': CircleX,
  'triangle-alert': TriangleAlert,
  'clock': Clock,
  'more-horizontal': MoreHorizontal,
  'more-vertical': MoreVertical,
  'grip-vertical': GripVertical,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  'panel-right-close': PanelRightClose,
  'panel-right-open': PanelRightOpen,
  'file-code': FileCode,
  'file-text': FileText,
  'palette': Palette,
  'arrow-down': ArrowDown,
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
  'undo-2': Undo2,
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
  'strategy': Compass,
  'compass': Compass,
  'map': Map,
  'network': Network,
  'folder-git-2': FolderGit2,
  'folder-tree': FolderTree,
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
  'save': Save,
  'split': Split,
  'expand': Expand,
};

export const isIconName = (name: string): name is IconName => name in iconMap;

export const Icon: React.FC<IconProps> = ({ name, size = 16, className, style }) => {
  const IconComponent = iconMap[name];
  if (!IconComponent) return null;

  return <IconComponent size={size} className={className} style={style} />;
};
