/**
 * MCP (Model Context Protocol) Types
 * 
 * These types define the MCP server management and tool calling interfaces
 * for the Macro chat functionality.
 */

// ============ Server Configuration ============

/**
 * Transport type for MCP server communication
 * - stdio: Communicate with server via stdin/stdout (most common)
 * - sse: Server-Sent Events over HTTP
 */
export type McpTransport = 'stdio' | 'sse';

/**
 * Connection status of an MCP server
 */
export type McpServerStatus = 
  | 'disconnected'  // Server config exists but not running
  | 'connecting'    // Currently attempting to connect
  | 'connected'     // Successfully connected and ready
  | 'error';        // Connection failed or server crashed

/**
 * Configuration for an MCP server
 */
export interface McpServerConfig {
  /** Unique identifier for this server configuration */
  id: string;
  /** Human-readable name */
  name: string;
  /** Transport type */
  transport: McpTransport;
  /** For stdio: command to execute (e.g., "npx", "node", "python") */
  command?: string;
  /** For stdio: arguments to pass to command */
  args?: string[];
  /** Environment variables to set for the process */
  env?: Record<string, string>;
  /** For sse: URL endpoint */
  url?: string;
  /** Whether the server should auto-connect on app start */
  autoConnect: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Runtime state of an MCP server (combines config + status)
 */
export interface McpServer {
  config: McpServerConfig;
  status: McpServerStatus;
  /** Error message if status is 'error' */
  error?: string;
  /** Available tools from this server (populated after connection) */
  tools: McpTool[];
  /** Available resources from this server */
  resources: McpResource[];
}

// ============ Tools ============

/**
 * JSON Schema for tool input parameters
 */
export interface McpToolInputSchema {
  type: 'object';
  properties?: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    default?: unknown;
  }>;
  required?: string[];
}

/**
 * A tool exposed by an MCP server
 */
export interface McpTool {
  /** Tool name (unique within the server) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema describing the input parameters */
  inputSchema: McpToolInputSchema;
  /** ID of the server providing this tool */
  serverId: string;
}

/**
 * A tool call request (sent to AI or for execution)
 */
export interface McpToolCall {
  /** Unique ID for this tool call */
  id: string;
  /** Name of the tool to call */
  name: string;
  /** Arguments to pass to the tool (JSON object) */
  arguments: Record<string, unknown>;
  /** Server ID that provides this tool */
  serverId: string;
}

/**
 * Result of executing a tool call
 */
export interface McpToolResult {
  /** ID of the original tool call */
  toolCallId: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Result content (if success) */
  content?: McpContent[];
  /** Error message (if failure) */
  error?: string;
}

// ============ Resources ============

/**
 * A resource exposed by an MCP server
 */
export interface McpResource {
  /** Resource URI */
  uri: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** MIME type of the resource content */
  mimeType?: string;
  /** Server ID that provides this resource */
  serverId: string;
}

// ============ Content Types ============

/**
 * Content returned by tools or resources
 */
export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;  // base64 encoded
  mimeType: string;
}

export interface McpResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    text?: string;
    blob?: string;  // base64 encoded
    mimeType?: string;
  };
}

// ============ Chat Integration ============

/**
 * A tool call within a chat message (OpenAI-compatible format)
 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

/**
 * Extended chat message that can include tool calls
 */
export interface ChatMessageWithTools {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Tool calls requested by the assistant */
  tool_calls?: ChatToolCall[];
  /** For role='tool': ID of the tool call this is responding to */
  tool_call_id?: string;
  /** For role='tool': Name of the tool */
  name?: string;
}

/**
 * Tool definition for AI provider (OpenAI-compatible format)
 */
export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: McpToolInputSchema;
  };
}

// ============ Store State ============

/**
 * State for MCP server management
 */
export interface McpState {
  /** All configured servers */
  servers: Record<string, McpServer>;
  /** Loading state */
  isLoading: boolean;
  /** Last error */
  lastError: string | null;
}
