//! MCP (Model Context Protocol) Module
//!
//! This module handles MCP server management for the chat functionality:
//! - Server configuration persistence
//! - Process lifecycle (spawn, connect, disconnect)
//! - JSON-RPC protocol over stdio
//! - Tool discovery and invocation

mod client;
mod protocol;
mod server;
mod types;

pub use client::{create_mcp_manager, McpClientManager, McpError};
pub use types::*;
