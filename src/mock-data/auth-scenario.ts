import {
  Project,
  ProjectGroup,
  Plan,
  Task,
  ChatMessage,
  PredictedGitTree,
  GitCommit,
  Conversation,
} from '../types';

// Detailed mock data for "Add User Authentication" scenario

export const mockProjects: ProjectGroup[] = [
  {
    id: 'group-1',
    name: 'E-Commerce Platform',
    isOpen: true,
    projects: [
      {
        id: 'proj-1',
        name: 'Frontend',
        path: '/path/to/frontend',
        created_at: '2026-01-10T09:00:00Z',
        status: 'active',
        metadata: {
          description: 'React + TypeScript frontend for e-commerce platform',
          tags: ['react', 'typescript', 'vite', 'tailwind'],
          team_members: ['Alice', 'Bob', 'Charlie'],
          api_contracts: [],
          dependencies: [],
        },
      },
      {
        id: 'proj-2',
        name: 'Backend',
        path: '/path/to/backend',
        created_at: '2026-01-10T09:00:00Z',
        status: 'active',
        metadata: {
          description: 'Rust + Tauri backend API with SQLite database',
          tags: ['rust', 'tauri', 'sqlite', 'api'],
          team_members: ['Charlie', 'Diana'],
          api_contracts: [],
          dependencies: [],
        },
      },
    ],
  },
  {
    id: 'group-2',
    name: 'Standalone Tools',
    isOpen: false,
    projects: [
      {
        id: 'proj-3',
        name: 'CLI Tool',
        path: '/path/to/cli-tool',
        created_at: '2026-01-12T14:00:00Z',
        status: 'active',
        metadata: {
          description: 'Command-line utility for data migration',
          tags: ['rust', 'cli', 'migration'],
          team_members: ['Eve'],
          api_contracts: [],
          dependencies: [],
        },
      },
    ],
  },
];

export const mockAuthPlan: Plan = {
  id: 'plan-1',
  description: 'Add user authentication with JWT tokens',
  created_at: '2026-01-14T10:00:00Z',
  updated_at: '2026-01-14T11:30:00Z',
  status: 'InProgress',
  project_ids: ['proj-1', 'proj-2'],
  tasks: [
    {
      id: 'task-1',
      plan_id: 'plan-1',
      project_id: 'proj-1',
      title: 'Create login page component',
      description: 'Build login form with email/password fields, validation, and loading states',
      status: 'Completed',
      dependencies: [],
      estimated_changes: [
        {
          path: 'src/components/auth/LoginPage.tsx',
          operation: 'Create',
          diff_preview: '+ new file: Login component with form validation',
        },
      ],
      code_diff: {
        file_path: 'src/components/auth/LoginPage.tsx',
        old_content: '',
        new_content: `import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(email, password);
    } catch (err) {
      setError('Invalid email or password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="card p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6">Sign In</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              required
            />
          </div>
          {error && <p className="text-accent-error text-sm">{error}</p>}
          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;`,
        language: 'typescript',
      },
    },
    {
      id: 'task-2',
      plan_id: 'plan-1',
      project_id: 'proj-1',
      title: 'Create registration page component',
      description:
        'Build registration form with email, password, and password confirmation fields. Validation: minimum 8 characters + 1 uppercase letter',
      status: 'Completed',
      dependencies: ['task-1'],
      estimated_changes: [
        {
          path: 'src/components/auth/RegisterPage.tsx',
          operation: 'Create',
          diff_preview: '+ new file: Register component with password validation',
        },
      ],
      code_diff: {
        file_path: 'src/components/auth/RegisterPage.tsx',
        old_content: '',
        new_content: `import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';

const validatePassword = (password: string): boolean => {
  return password.length >= 8 && /[A-Z]/.test(password);
};

const RegisterPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!validatePassword(password)) {
      setError(
        'Password must be at least 8 characters with 1 uppercase letter'
      );
      return;
    }

    setIsLoading(true);

    try {
      await register(email, password);
    } catch (err) {
      setError('Registration failed. Email may already be in use.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="card p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6">Create Account</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              required
            />
            <p className="text-xs text-text-muted mt-1">
              Min 8 chars, 1 uppercase letter
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
              required
            />
          </div>
          {error && <p className="text-accent-error text-sm">{error}</p>}
          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full"
          >
            {isLoading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default RegisterPage;`,
        language: 'typescript',
      },
    },
    {
      id: 'task-3',
      plan_id: 'plan-1',
      project_id: 'proj-1',
      title: 'Implement auth context and hooks',
      description:
        'Create AuthContext for managing authentication state and useAuth hook for component access. Auto-refresh tokens 5 minutes before expiration',
      status: 'Completed',
      dependencies: ['task-2'],
      estimated_changes: [
        {
          path: 'src/contexts/AuthContext.tsx',
          operation: 'Create',
          diff_preview: '+ new file: AuthContext provider with auto-refresh',
        },
        {
          path: 'src/hooks/useAuth.ts',
          operation: 'Create',
          diff_preview: '+ new file: useAuth custom hook',
        },
      ],
    },
    {
      id: 'task-4',
      plan_id: 'plan-1',
      project_id: 'proj-2',
      title: 'Create user authentication API endpoints',
      description:
        'Implement /auth/login, /auth/register, and /auth/logout Tauri commands',
      status: 'Completed',
      dependencies: [],
      estimated_changes: [
        {
          path: 'src-tauri/src/commands/auth.rs',
          operation: 'Create',
          diff_preview: '+ new file: Auth commands module',
        },
        {
          path: 'src-tauri/src/lib.rs',
          operation: 'Modify',
          diff_preview: '+ register auth module',
        },
      ],
      code_diff: {
        file_path: 'src-tauri/src/commands/auth.rs',
        old_content: '',
        new_content: `use serde::{Deserialize, Serialize};
use crate::jwt::{generate_token, validate_token};
use crate::database::UserDatabase;

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserInfo,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub email: String,
}

#[tauri::command]
pub async fn login(email: String, password: String) -> Result<AuthResponse, String> {
    let db = UserDatabase::new().await.map_err(|e| e.to_string())?;

    // Validate credentials
    let user = db
        .verify_user(&email, &password)
        .await
        .map_err(|_| "Invalid email or password")?;

    // Generate JWT token
    let token = generate_token(&user.id, &user.email).map_err(|e| e.to_string())?;

    Ok(AuthResponse {
        token,
        user: UserInfo { id: user.id, email: user.email },
    })
}

#[tauri::command]
pub async fn register(email: String, password: String) -> Result<AuthResponse, String> {
    let db = UserDatabase::new().await.map_err(|e| e.to_string())?;

    // Hash password and create user
    let user = db
        .create_user(&email, &password)
        .await
        .map_err(|e| e.to_string())?;

    // Generate JWT token
    let token = generate_token(&user.id, &user.email).map_err(|e| e.to_string())?;

    Ok(AuthResponse {
        token,
        user: UserInfo { id: user.id, email: user.email },
    })
}

#[tauri::command]
pub async fn logout() -> Result<(), String> {
    // In a real app, you might want to invalidate the token
    Ok(())
}`,
        language: 'rust',
      },
    },
    {
      id: 'task-5',
      plan_id: 'plan-1',
      project_id: 'proj-2',
      title: 'Implement JWT token generation and validation',
      description:
        'Create JWT utilities for token signing and verification using HS256 algorithm with 24-hour expiration',
      status: 'AwaitingResponse',
      dependencies: ['task-4'],
      estimated_changes: [
        {
          path: 'src-tauri/src/jwt.rs',
          operation: 'Create',
          diff_preview: '+ new file: JWT utilities',
        },
      ],
    },
  ],
  predicted_git_trees: {
    'proj-1': {
      branch: 'feature/user-auth',
      structure: [
        {
          name: 'src',
          type: 'directory',
          status: 'modified',
          children: [
            {
              name: 'components',
              type: 'directory',
              status: 'modified',
              children: [
                {
                  name: 'auth',
                  type: 'directory',
                  status: 'added',
                  children: [
                    {
                      name: 'LoginPage.tsx',
                      type: 'file',
                      status: 'added',
                    },
                    {
                      name: 'RegisterPage.tsx',
                      type: 'file',
                      status: 'added',
                    },
                  ],
                },
              ],
            },
            {
              name: 'contexts',
              type: 'directory',
              status: 'added',
              children: [
                {
                  name: 'AuthContext.tsx',
                  type: 'file',
                  status: 'added',
                },
              ],
            },
            {
              name: 'hooks',
              type: 'directory',
              status: 'modified',
              children: [
                {
                  name: 'useAuth.ts',
                  type: 'file',
                  status: 'added',
                },
              ],
            },
            {
              name: 'App.tsx',
              type: 'file',
              status: 'modified',
            },
          ],
        },
      ],
      modified_files_count: 7,
    },
    'proj-2': {
      branch: 'feature/user-auth',
      structure: [
        {
          name: 'src-tauri',
          type: 'directory',
          status: 'modified',
          children: [
            {
              name: 'src',
              type: 'directory',
              status: 'modified',
              children: [
                {
                  name: 'commands',
                  type: 'directory',
                  status: 'modified',
                  children: [
                    {
                      name: 'auth.rs',
                      type: 'file',
                      status: 'added',
                    },
                  ],
                },
                {
                  name: 'jwt.rs',
                  type: 'file',
                  status: 'added',
                },
                {
                  name: 'lib.rs',
                  type: 'file',
                  status: 'modified',
                },
              ],
            },
          ],
        },
      ],
      modified_files_count: 4,
    },
  },
};

export const getGitTree = (
  projectId: string
): PredictedGitTree | undefined => {
  return mockAuthPlan.predicted_git_trees[projectId];
};

export const getTaskById = (taskId: string): Task | undefined => {
  return mockAuthPlan.tasks.find((t) => t.id === taskId);
};

export const mockCommits: GitCommit[] = [
  {
    id: 'commit-1',
    hash: 'a1b2c3d4e5f6',
    message: 'feat: Add user authentication system with JWT tokens',
    author: 'AI Assistant',
    date: '2026-01-14T10:30:00Z',
    status: 'done',
    task_id: 'task-1',
  },
  {
    id: 'commit-2',
    hash: 'd4e5f6g7h8i9',
    message: 'feat: Create login page component with form validation',
    author: 'AI Assistant',
    date: '2026-01-14T10:35:00Z',
    status: 'done',
    task_id: 'task-1',
  },
  {
    id: 'commit-3',
    hash: 'j7k8l9m2n3o4',
    message: 'feat: Create registration page with password validation',
    author: 'AI Assistant',
    date: '2026-01-14T10:40:00Z',
    status: 'done',
    task_id: 'task-2',
  },
  {
    id: 'commit-4',
    hash: 'p1o2i3u4y5t6',
    message: 'feat: Implement auth context with auto-refresh logic',
    author: 'AI Assistant',
    date: '2026-01-14T10:45:00Z',
    status: 'done',
    task_id: 'task-3',
  },
  {
    id: 'commit-5',
    hash: 'q5r6s7w8e9u1i',
    message: 'feat: Create auth API endpoints (login, register, logout)',
    author: 'AI Assistant',
    date: '2026-01-14T11:00:00Z',
    status: 'done',
    task_id: 'task-4',
  },
  {
    id: 'commit-6',
    hash: 't8u9v2x0y3z2',
    message: 'feat: Implement JWT token generation with HS256 algorithm',
    author: 'AI Assistant',
    date: '2026-01-14T11:15:00Z',
    status: 'in-progress',
    task_id: 'task-5',
  },
];

export const getProjectById = (
  projectId: string
): Project | undefined => {
  for (const group of mockProjects) {
    const project = group.projects.find((p) => p.id === projectId);
    if (project) return project;
  }
  return undefined;
};

// Mock conversations data
export const mockConversations: Conversation[] = [
  {
    id: 'conv-1',
    title: 'Create login page component',
    task_id: 'task-1',
    project_id: 'proj-1',
    last_message: 'Approved.',
    message_count: 4,
    updated_at: '2026-01-14T10:06:00Z',
    is_unread: false,
  },
  {
    id: 'conv-2',
    title: 'Create registration page component',
    task_id: 'task-2',
    project_id: 'proj-1',
    last_message: 'Should I apply this change?',
    message_count: 3,
    updated_at: '2026-01-14T10:12:00Z',
    is_unread: false,
  },
  {
    id: 'conv-3',
    title: 'Implement auth context',
    task_id: 'task-3',
    project_id: 'proj-1',
    last_message: 'Approved. This looks good.',
    message_count: 3,
    updated_at: '2026-01-14T10:20:00Z',
    is_unread: false,
  },
  {
    id: 'conv-4',
    title: 'Create auth API endpoints',
    task_id: 'task-4',
    project_id: 'proj-2',
    last_message: 'Starting backend implementation...',
    message_count: 2,
    updated_at: '2026-01-14T10:22:00Z',
    is_unread: false,
  },
  {
    id: 'conv-5',
    title: 'Implement JWT token generation',
    task_id: 'task-5',
    project_id: 'proj-2',
    last_message: 'Should I apply this change?',
    message_count: 5,
    updated_at: '2026-01-14T10:25:00Z',
    is_unread: false,
  },
  {
    id: 'conv-free-1',
    title: 'Code review: Refactor user service',
    task_id: null,
    project_id: 'proj-1',
    last_message: 'I think we should split it into smaller functions.',
    message_count: 7,
    updated_at: '2026-01-15T09:30:00Z',
    is_unread: true,
  },
  {
    id: 'conv-free-2',
    title: 'Database optimization discussion',
    task_id: null,
    project_id: 'proj-2',
    last_message: 'Let me check the query performance metrics first.',
    message_count: 12,
    updated_at: '2026-01-15T10:15:00Z',
    is_unread: true,
  },
  {
    id: 'conv-free-3',
    title: 'Deployment strategy planning',
    task_id: null,
    project_id: null,
    last_message: 'We should use blue-green deployment.',
    message_count: 5,
    updated_at: '2026-01-14T16:45:00Z',
    is_unread: false,
  },
];

// Mock messages with conversation_id
export const mockChatMessages: ChatMessage[] = [
  {
    id: 'msg-0',
    task_id: '',
    conversation_id: 'conv-plan',
    role: 'assistant',
    content: `I've analyzed your request and created a plan:

**Plan: Add User Authentication with JWT Tokens**

**Frontend Tasks:**
1. Create login page component
2. Create registration page component  
3. Implement auth context and hooks for state management

**Backend Tasks:**
4. Create user authentication API endpoints (/auth/login, /auth/register)
5. Implement JWT token generation and validation

**Predicted Git Changes:**
- Frontend: 7 new/modified files
- Backend: 4 new/modified files

Ready to proceed to Implementation Mode?`,
    timestamp: '2026-01-14T10:01:00Z',
  },
  {
    id: 'msg-1',
    task_id: '',
    conversation_id: 'conv-plan',
    role: 'user',
    content: 'Yes, looks good. Let\'s proceed.',
    timestamp: '2026-01-14T10:02:00Z',
  },
  {
    id: 'msg-2',
    task_id: 'task-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: `Starting Task 1: Create login page component...

I've created \`src/components/auth/LoginPage.tsx\` with:
- Email input field with validation
- Password input field
- Login button with loading state
- Error message display
- Link to registration page

**Code Preview:**
\`\`\`tsx
const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // ... implementation
};
\`\`\`

Should I apply this change?`,
    timestamp: '2026-01-14T10:05:00Z',
  },
  {
    id: 'msg-3',
    task_id: 'task-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'Approved.',
    timestamp: '2026-01-14T10:06:00Z',
  },
];
