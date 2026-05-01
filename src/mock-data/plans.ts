import type {
  PlanNode,
  PlanEdge,
  PredictedBranch,
  PredictedCommit,
  PlanBlock,
  Conversation,
  ChatMessage,
} from '../types';

export const mockPlanNodes: PlanNode[] = [
  {
    id: 'node-1',
    title: 'API Specifications',
    description: 'Define REST API endpoints, request/response schemas, and authentication flow',
    type: 'spec',
    status: 'completed',
    dependencies: [],
    assignedBranch: 'feature/api-specs',
    projectId: 'proj-1',
    estimatedTime: '2h',
  },
  {
    id: 'node-2',
    title: 'Database Schema',
    description: 'Design tables for users, products, orders, and cart',
    type: 'spec',
    status: 'completed',
    dependencies: ['node-1'],
    assignedBranch: 'feature/api-specs',
    projectId: 'proj-2',
    estimatedTime: '1h',
  },
  {
    id: 'node-3',
    title: 'Backend: User Authentication',
    description: 'Implement JWT auth, login, register, and password reset endpoints',
    type: 'feature',
    status: 'in-progress',
    dependencies: ['node-1', 'node-2'],
    assignedBranch: 'feature/backend-auth',
    projectId: 'proj-2',
    estimatedTime: '4h',
  },
  {
    id: 'node-4',
    title: 'Frontend: Login Page',
    description: 'Create login form with validation, error handling, and loading states',
    type: 'feature',
    status: 'in-progress',
    dependencies: ['node-1'], // Start parallel with backend
    assignedBranch: 'feature/frontend-auth',
    projectId: 'proj-1',
    estimatedTime: '3h',
  },
  {
    id: 'node-5',
    title: 'Frontend: Register Page',
    description: 'Create registration form with email verification flow',
    type: 'feature',
    status: 'blocked',
    dependencies: ['node-1', 'node-4'], // Depends on login components setup
    assignedBranch: 'feature/frontend-auth',
    projectId: 'proj-1',
    estimatedTime: '2h',
  },
  {
    id: 'node-6',
    title: 'Backend: Product CRUD',
    description: 'Implement product listing, search, and admin management',
    type: 'feature',
    status: 'blocked',
    dependencies: ['node-3'], // Needs auth (admin roles)
    assignedBranch: 'feature/backend-products',
    projectId: 'proj-2',
    estimatedTime: '5h',
  },
  {
    id: 'node-7',
    title: 'Frontend: Product Catalog',
    description: 'Display products with filtering, sorting, and pagination',
    type: 'feature',
    status: 'blocked',
    dependencies: ['node-4', 'node-6'], // Needs auth context and backend API
    assignedBranch: 'feature/frontend-products',
    projectId: 'proj-1',
    estimatedTime: '6h',
  },
  {
    id: 'node-9',
    title: 'Backend: Order Service',
    description: 'Order processing, inventory check, and cart management',
    type: 'feature',
    status: 'blocked',
    dependencies: ['node-6'], // Depends on products
    assignedBranch: 'feature/backend-orders',
    projectId: 'proj-2',
    estimatedTime: '4h',
  },
   {
    id: 'node-10',
    title: 'Frontend: Shopping Cart',
    description: 'Cart state management, local storage persistence',
    type: 'feature',
    status: 'blocked',
    dependencies: ['node-7'], // Depends on product catalog UI
    assignedBranch: 'feature/frontend-orders',
    projectId: 'proj-1',
    estimatedTime: '4h',
  },
  {
    id: 'node-8',
    title: 'Integration Testing',
    description: 'End-to-end tests for auth and product flows',
    type: 'milestone',
    status: 'blocked',
    dependencies: ['node-5', 'node-9', 'node-10'], // Depends on all main features
    estimatedTime: '3h',
  },
];

// Edges derived from dependencies
export const mockPlanEdges: PlanEdge[] = mockPlanNodes.flatMap((node) =>
  node.dependencies.map((depId) => ({
    id: `edge-${depId}-${node.id}`,
    source: depId,
    target: node.id,
  }))
);

// Mock Predicted Branches for git flow visualization
export const mockPredictedBranches: PredictedBranch[] = [
  {
    id: 'branch-main',
    name: 'main',
    color: '#6366f1',
    parentBranch: null,
    projectId: 'proj-1',
    taskIds: ['node-8'],
    status: 'active',
  },
  {
    id: 'branch-api-specs',
    name: 'feature/api-specs',
    color: '#22c55e',
    parentBranch: 'branch-main',
    projectId: 'proj-1',
    taskIds: ['node-1'],
    status: 'merged',
  },
  {
    id: 'branch-database-schema',
    name: 'feature/database-schema',
    color: '#06b6d4',
    parentBranch: 'branch-main',
    projectId: 'proj-2',
    taskIds: ['node-2'],
    status: 'merged',
  },
  {
    id: 'branch-backend-auth',
    name: 'feature/backend-auth',
    color: '#f59e0b',
    parentBranch: 'branch-main',
    projectId: 'proj-2',
    taskIds: ['node-3'],
    status: 'active',
  },
  {
    id: 'branch-frontend-auth',
    name: 'feature/frontend-auth',
    color: '#ec4899',
    parentBranch: 'branch-main',
    projectId: 'proj-1',
    taskIds: ['node-4'],
    status: 'active',
  },
  {
    id: 'branch-frontend-register',
    name: 'feature/frontend-register',
    color: '#06b6d4',
    parentBranch: 'branch-main',
    projectId: 'proj-1',
    taskIds: ['node-5'],
    status: 'pending',
  },
  {
    id: 'branch-backend-products',
    name: 'feature/backend-products',
    color: '#8b5cf6',
    parentBranch: 'branch-backend-auth',
    projectId: 'proj-2',
    taskIds: ['node-6'],
    status: 'pending',
  },
  {
    id: 'branch-frontend-products',
    name: 'feature/frontend-products',
    color: '#14b8a6',
    parentBranch: 'branch-frontend-auth',
    projectId: 'proj-1',
    taskIds: ['node-7'],
    status: 'pending',
  },
   {
    id: 'branch-backend-orders',
    name: 'feature/backend-orders',
    color: '#ef4444',
    parentBranch: 'branch-backend-products',
    projectId: 'proj-2',
    taskIds: ['node-9'],
    status: 'pending',
  },
  {
    id: 'branch-frontend-orders',
    name: 'feature/frontend-orders',
    color: '#3b82f6',
    parentBranch: 'branch-frontend-products',
    projectId: 'proj-1',
    taskIds: ['node-10'],
    status: 'pending',
  },
];

// Mock Predicted Commits
export const mockPredictedCommits: PredictedCommit[] = [
  { id: 'commit-1', branchId: 'branch-api-specs', message: 'docs: add API specifications', taskId: 'node-1', status: 'done' },
  { id: 'commit-2', branchId: 'branch-database-schema', message: 'docs: add database schema', taskId: 'node-2', status: 'done' },
  { id: 'commit-3', branchId: 'branch-backend-auth', message: 'feat: implement JWT authentication', taskId: 'node-3', status: 'done' },
  { id: 'commit-4', branchId: 'branch-backend-auth', message: 'feat: add login endpoint', taskId: 'node-3', status: 'pending' },
  { id: 'commit-5', branchId: 'branch-frontend-auth', message: 'feat: create login page component', taskId: 'node-4', status: 'done' },
  { id: 'commit-6', branchId: 'branch-frontend-auth', message: 'feat: add form validation', taskId: 'node-4', status: 'pending' },
  { id: 'commit-7', branchId: 'branch-frontend-register', message: 'feat: create register page', taskId: 'node-5', status: 'pending' },
  { id: 'commit-8', branchId: 'branch-backend-products', message: 'feat: implement product CRUD', taskId: 'node-6', status: 'pending' },
  { id: 'commit-9', branchId: 'branch-frontend-products', message: 'feat: create product catalog', taskId: 'node-7', status: 'pending' },
];

// Mock Plan Blocks for interactive messages
export const mockPlanBlocks: PlanBlock[] = [
  {
    id: 'block-1',
    type: 'spec',
    title: 'API Endpoints',
    items: [
      { id: 'item-1', text: 'POST /api/auth/login', checked: true },
      { id: 'item-2', text: 'POST /api/auth/register', checked: true },
      { id: 'item-3', text: 'GET /api/products', checked: true },
      { id: 'item-4', text: 'POST /api/cart/add', checked: false },
    ],
    status: 'accepted',
  },
  {
    id: 'block-2',
    type: 'task-group',
    title: 'Phase 1: Authentication',
    items: [
      { id: 'item-5', text: 'Backend JWT implementation', checked: true },
      { id: 'item-6', text: 'Frontend login page', checked: true },
      { id: 'item-7', text: 'Frontend register page', checked: false },
    ],
    status: 'accepted',
  },
  {
    id: 'block-3',
    type: 'dependency',
    title: 'Parallel Tasks',
    items: [
      { id: 'item-8', text: 'Backend and Frontend can work in parallel after specs', checked: true },
      { id: 'item-9', text: 'Product catalog waits for auth completion', checked: true },
    ],
    status: 'draft',
  },
];

// Mock Architect Conversation
export const mockArchitectConversation: Conversation = {
  id: 'conv-architect-1',
  title: 'E-Commerce Platform Architecture',
  description: '',
  scope_mode: 'Architect',
  task_id: null,
  project_id: 'proj-1',
  last_message: 'I\'ve created the dependency graph for your e-commerce platform...',
  message_count: 6,
  updated_at: '2026-01-31T10:30:00Z',
  is_unread: false,
};

export const mockArchitectMessages: ChatMessage[] = [
  {
    id: 'msg-arch-1',
    task_id: '',
    conversation_id: 'conv-architect-1',
    role: 'user',
    content: 'I want to build a fruit selling e-commerce application with user authentication and a product catalog.',
    timestamp: '2026-01-31T10:00:00Z',
  },
  {
    id: 'msg-arch-2',
    task_id: '',
    conversation_id: 'conv-architect-1',
    role: 'assistant',
    content: `Great! Let me help you architect this e-commerce platform. I'll break it down into manageable phases.

<think>
The user wants a fruit e-commerce app. Key components:
1. User authentication (login/register)
2. Product catalog (fruits listing)
3. Shopping cart
4. Checkout flow

I should start with API specs, then parallelize backend and frontend work.
</think>

## Proposed Architecture

I recommend a **parallel development approach** where the Backend and Frontend teams can work simultaneously after the API specifications are defined.

### Phase 1: Specifications
First, we'll define the API contracts so both teams know the interfaces.

### Phase 2: Parallel Development
- **Backend Team**: Implements authentication and product APIs
- **Frontend Team**: Builds UI components using the API specs

### Phase 3: Integration
Merge the parallel branches and run integration tests.

Would you like me to create the detailed task breakdown?`,
    timestamp: '2026-01-31T10:05:00Z',
  },
  {
    id: 'msg-arch-3',
    task_id: '',
    conversation_id: 'conv-architect-1',
    role: 'user',
    content: 'Yes, please create the task breakdown with dependencies.',
    timestamp: '2026-01-31T10:10:00Z',
  },
  {
    id: 'msg-arch-4',
    task_id: '',
    conversation_id: 'conv-architect-1',
    role: 'assistant',
    content: `I've created a comprehensive task breakdown. You can see the dependency graph on the right panel.

## Task Overview

### Specifications (Sequential)
1. **API Specifications** - Define all REST endpoints
2. **Database Schema** - Design tables (depends on API specs)

### Backend Features (Branch: feature/backend-*)
3. **User Authentication** - JWT, login, register (depends on specs)
4. **Product CRUD** - Listing, search, admin (depends on auth)

### Frontend Features (Branch: feature/frontend-*)
5. **Login Page** - Form with validation (depends on API specs)
6. **Register Page** - Email verification flow (depends on API specs)
7. **Product Catalog** - Display with filters (depends on login + product API)

### Milestone
8. **Integration Testing** - E2E tests (depends on all features)

The graph shows which tasks can run in parallel. Backend auth and Frontend login can start simultaneously once specs are done.

Do you want to validate this plan and start implementation?`,
    timestamp: '2026-01-31T10:20:00Z',
    choices: [
      { id: 'choice-1', text: 'Validate and start implementation' },
      { id: 'choice-2', text: 'Modify the plan' },
      { id: 'choice-3', text: 'Add more features' },
    ],
  },
];

// Mock Chat-only Conversations (not linked to projects)
export const mockChatConversations: Conversation[] = [
  {
    id: 'conv-chat-1',
    title: 'General Programming Questions',
    description: '',
    scope_mode: 'Chat',
    task_id: null,
    project_id: null,
    last_message: 'How do I optimize React performance?',
    message_count: 12,
    updated_at: '2026-01-30T15:00:00Z',
    is_unread: false,
  },
  {
    id: 'conv-chat-2',
    title: 'Learning Rust',
    description: '',
    scope_mode: 'Chat',
    task_id: null,
    project_id: null,
    last_message: 'What are the best practices for error handling in Rust?',
    message_count: 8,
    updated_at: '2026-01-29T10:00:00Z',
    is_unread: true,
  },
  {
    id: 'conv-chat-3',
    title: 'Career Advice',
    description: '',
    scope_mode: 'Chat',
    task_id: null,
    project_id: null,
    last_message: 'Should I focus on backend or full-stack development?',
    message_count: 5,
    updated_at: '2026-01-28T18:00:00Z',
    is_unread: false,
  },
];

export const mockChatMessages: ChatMessage[] = [
  {
    id: 'msg-chat-1',
    task_id: '',
    conversation_id: 'conv-chat-1',
    role: 'user',
    content: 'How do I optimize React performance?',
    timestamp: '2026-01-30T15:00:00Z',
  },
  {
    id: 'msg-chat-2',
    task_id: '',
    conversation_id: 'conv-chat-1',
    role: 'assistant',
    content: `Here are the key React performance optimization techniques:

## 1. Memoization
- Use \`React.memo()\` for components that render often with same props
- Use \`useMemo()\` for expensive calculations
- Use \`useCallback()\` for callback functions passed to children

## 2. Code Splitting
\`\`\`tsx
const LazyComponent = React.lazy(() => import('./HeavyComponent'));
\`\`\`

## 3. Virtualization
For long lists, use libraries like \`react-window\` or \`@tanstack/virtual\`.

## 4. State Management
- Keep state as local as possible
- Avoid unnecessary re-renders by splitting context

Would you like me to elaborate on any of these?`,
    timestamp: '2026-01-30T15:01:00Z',
  },
];
