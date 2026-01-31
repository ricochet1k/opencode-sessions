/**
 * OpenCode Session Management Plugin
 *
 * Unified session tool with agent switching for workflow orchestration.
 *
 * Features:
 * - Context injection (silent, no AI response)
 * - New session creation with agent selection
 * - Session compaction (token optimization)
 * - Session forking (safe experimentation)
 * - Agent-to-agent handoffs
 * - Multi-agent collaboration
 *
 * @version 1.0.0
 * @license MIT
 * @author M. Adel Alhashemi
 * @see https://github.com/malhashemi/opencode-sessions
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { join } from "path"
import { readdir } from "fs/promises"
import os from "os"
import matter from "gray-matter"

interface AgentInfo {
  name: string
  description?: string
}

/**
 * Discover primary agents by scanning agent directories for markdown files
 * and checking opencode.json for disabled agents.
 *
 * Agent discovery process:
 * 1. Scans ~/.config/opencode/agent/ and .opencode/agent/ for .md files
 * 2. Parses YAML frontmatter to find agents with mode: "primary" or "all"
 * 3. Adds built-in agents (build, plan) if not overridden by .md files
 * 4. Checks opencode.json files for disabled agents
 * 5. Returns list of enabled primary agents
 *
 * Note: Built-in agents (build, plan) can be:
 * - Overridden by creating build.md or plan.md files
 * - Disabled via opencode.json with { agent: { build: { disable: true } } }
 */
async function discoverAgents(projectDir: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = []
  const disabledAgents = new Set<string>()

  // Determine XDG config paths
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const xdgBase = xdgConfigHome
    ? join(xdgConfigHome, "opencode")
    : join(os.homedir(), ".config/opencode")

  const agentDirs = [
    join(xdgBase, "agent"), // XDG config agents
    join(projectDir, ".opencode/agent"), // Project-local agents
  ]

  const configPaths = [
    join(xdgBase, "opencode.json"), // XDG config
    join(projectDir, ".opencode/opencode.json"), // Project-local config
  ]

  // First, discover all primary agents from markdown files
  for (const agentDir of agentDirs) {
    try {
      const files = await readdir(agentDir)

      for (const file of files) {
        // Only process markdown files
        if (!file.endsWith(".md")) continue

        try {
          // Read file content
          const filePath = join(agentDir, file)
          const content = await Bun.file(filePath).text()

          // Parse YAML frontmatter
          const { data } = matter(content)

          // Check if this is a primary agent
          const mode = data.mode
          if (mode === "primary" || mode === "all") {
            // Extract agent name from filename (remove .md extension)
            const agentName = file.replace(/\.md$/, "")
            const agentDescription = data.description

            // Add to list if not already present
            if (!agents.some((a) => a.name === agentName)) {
              agents.push({
                name: agentName,
                description: agentDescription,
              })
            }
          }
        } catch (error) {
          // Skip files that can't be parsed
          continue
        }
      }
    } catch (error) {
      // Silently skip directories that don't exist
      // This is expected - not all paths will have agent directories
    }
  }

  // Add built-in agents if they weren't overridden by .md files
  for (const builtIn of ["build", "plan"]) {
    if (!agents.some((a) => a.name === builtIn)) {
      agents.unshift({
        name: builtIn,
        description:
          builtIn === "build"
            ? "General-purpose implementation agent for building features and fixing bugs"
            : "Strategic planning agent for architecture and design decisions",
      })
    }
  }

  // Second, check opencode.json files for disabled agents
  for (const configPath of configPaths) {
    try {
      const file = Bun.file(configPath)
      if (await file.exists()) {
        const config = await file.json()

        // Check for disabled agents
        if (config.agent && typeof config.agent === "object") {
          for (const [name, agentConfig] of Object.entries(config.agent)) {
            if (typeof agentConfig === "object" && agentConfig !== null) {
              const disabled = (agentConfig as any).disable
              if (disabled) {
                disabledAgents.add(name)
              }
            }
          }
        }
      }
    } catch (error) {
      // Silently skip files that don't exist or can't be parsed
    }
  }

  // Filter out disabled agents
  return agents.filter((agent) => !disabledAgents.has(agent.name))
}

export const SessionPlugin: Plugin = async (ctx) => {
  // Discover agents from filesystem (no blocking API calls!)
  const agents = await discoverAgents(ctx.directory)
  const agentList = agents
    .map((agent) => {
      const desc = agent.description || "No description available"
      return `  • ${agent.name} - ${desc}`
    })
    .join("\n")

  // Type definitions for state management
  type CompactionRequest = {
    providerID: string
    modelID: string
    agent?: string
    system?: string
    tools?: string
    text: string
    directory: string
  }

  type CompactionState = {
    phase: "compacting"
    agent?: string
    modelID?: string
    providerID?: string
    system?: string
    tools?: string
    text: string
    directory: string
  }

  type PendingMessage = {
    agent?: string
    modelID?: string
    providerID?: string
    system?: string
    tools?: string
    text: string
    directory: string
  }

  const formatSessionStatus = (status?: { type: string; [key: string]: any }) => {
    if (!status) return "unknown"
    if (status.type === "retry") {
      const attempt =
        typeof status.attempt === "number" ? ` (attempt ${status.attempt})` : ""
      return `retry${attempt}`
    }
    return status.type
  }

  // Store pending messages for agent relay communication (message mode)
  const pendingMessages = new Map<string, PendingMessage>()

  // Store pending compaction requests (compact mode)
  const pendingCompactions = new Map<string, CompactionRequest>()

  // Store active compactions (during compaction process)
  const activeCompactions = new Map<string, CompactionState>()

  return {
    // Hook: Listen for session.idle and session.compacted events
    event: async ({ event }) => {
      // Type guard for events with sessionID
      if (!("properties" in event) || !("sessionID" in event.properties)) {
        return
      }

      const sessionID = event.properties.sessionID as string

      // ===== Handle session.idle (both message and compact modes) =====
      if (event.type === "session.idle") {
        // MESSAGE MODE: Send pending message
          const pendingMessage = pendingMessages.get(sessionID)
          if (pendingMessage) {
            pendingMessages.delete(sessionID)

            try {
              await ctx.client.session.prompt({
                path: { id: sessionID },
                query: { directory: pendingMessage.directory },
                body: {
                  agent: pendingMessage.agent,
                  model:
                    pendingMessage.modelID && pendingMessage.providerID
                      ? {
                          modelID: pendingMessage.modelID,
                          providerID: pendingMessage.providerID,
                        }
                      : undefined,
                  system: pendingMessage.system,
                  tools: pendingMessage.tools
                    ? JSON.parse(pendingMessage.tools)
                    : undefined,
                  parts: [{ type: "text", text: pendingMessage.text }],
                },
              })
          } catch (error) {
            // Silently fail - error handling could be added here if needed
          }
          return
        }

        // COMPACT MODE: Start compaction (natural completion - no abort)
        const pendingCompaction = pendingCompactions.get(sessionID)
        if (pendingCompaction) {
          pendingCompactions.delete(sessionID)

          // Store state for session.compacted handler
          activeCompactions.set(sessionID, {
            phase: "compacting",
            agent: pendingCompaction.agent,
            modelID: pendingCompaction.modelID,
            providerID: pendingCompaction.providerID,
            system: pendingCompaction.system,
            tools: pendingCompaction.tools,
            text: pendingCompaction.text,
            directory: pendingCompaction.directory,
          })

          // Start compaction (don't await - let it run async)
          ctx.client.session
            .summarize({
              path: { id: sessionID },
              query: { directory: pendingCompaction.directory },
              body: {
                providerID: pendingCompaction.providerID,
                modelID: pendingCompaction.modelID,
              },
            })
            .catch((error) => {
              activeCompactions.delete(sessionID)
            })

          return
        }
      }

      // ===== Handle session.compacted (send message immediately) =====
      if (event.type === "session.compacted") {
        const state = activeCompactions.get(sessionID)

        if (state) {
          // Clean up state immediately
          activeCompactions.delete(sessionID)

          // Wait 100ms for compaction lock to fully release
          await new Promise((resolve) => setTimeout(resolve, 100))

          // Send message immediately - no abort needed!
          try {
            await ctx.client.session.prompt({
              path: { id: sessionID },
              query: { directory: state.directory },
              body: {
                agent: state.agent,
                model:
                  state.modelID && state.providerID
                    ? {
                        modelID: state.modelID,
                        providerID: state.providerID,
                      }
                    : undefined,
                system: state.system,
                tools: state.tools ? JSON.parse(state.tools) : undefined,
                parts: [{ type: "text", text: state.text }],
              },
            })
          } catch (error) {
            // Silently fail - error handling could be added here if needed
          }
        }
      }
    },

    tool: {
      session: tool({
        description: `Multi-agent collaboration and workflow orchestration across sessions.

THE FOUR PILLARS:

1. COLLABORATE (message) - Turn-based agent collaboration in same conversation
   Agents work together, passing the torch back and forth. Perfect for complex
   problems requiring multiple perspectives in a single thread.

2. HANDOFF (new) - Clean phase transitions with fresh context
   Complete one phase, hand off to another agent with a clean slate. No context
   baggage from previous work. Research → Implementation → Validation.

3. COMPRESS (compact) - Manual compression control with messaging and handoffs
   Trigger compaction when needed, include a message, and optionally hand off
   to a different agent. Maintain long conversations without token limits.

4. PARALLELIZE (fork) - Explore multiple approaches simultaneously
   Branch into independent sessions to try different solutions. Full primary
   agent capabilities in each fork. Compare approaches, pick the best.

AGENT PARAMETER (optional):

Specify which primary agent handles the message. Enables agent relay and handoffs.

Available primary agents:
${agentList}

If omitted, continues with current agent.

EXAMPLES:

  # COLLABORATE: Multi-agent problem solving
  session({ 
    mode: "message",
    agent: "plan",
    text: "Should we use microservices here?"
  })
  # Plan reviews, responds, can pass back to build
  
  # HANDOFF: Clean phase transition
  session({
    mode: "new",
    agent: "researcher", 
    text: "Research best practices for API design"
  })
  # Fresh session, no baggage from previous implementation work
  
  # COMPRESS: Long conversation with handoff
  session({
    mode: "compact",
    agent: "plan",
    text: "Continue architecture review"
  })
  # Compacts history, adds handoff context, plan agent responds
  
  # PARALLELIZE: Try multiple approaches
  session({
    mode: "fork",
    agent: "build",
    text: "Implement using Redux"
  })
  session({
    mode: "fork", 
    agent: "build",
    text: "Implement using Context API"
  })
  # Two independent sessions, compare results
`,

        args: {
          text: tool.schema
            .string()
            .describe("The text to send in the session"),
          mode: tool.schema
            .enum(["message", "new", "compact", "fork"])
            .describe("How to handle the session and text"),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Primary agent name (e.g., 'build', 'plan') for agent switching",
            ),
          directory: tool.schema
            .string()
            .optional()
            .describe(
              "Project directory for the session (defaults to current session directory)",
            ),
          title: tool.schema
            .string()
            .optional()
            .describe("Title for newly created or forked sessions"),
          modelID: tool.schema
            .string()
            .optional()
            .describe("Model ID for the session"),
          providerID: tool.schema
            .string()
            .optional()
            .describe("Provider ID for the session"),
          system: tool.schema
            .string()
            .optional()
            .describe("System instructions for the session"),
          tools: tool.schema
            .string()
            .optional()
            .describe("JSON string of tools permissions (e.g., '{\"read\": true}')"),
          async: tool.schema
            .boolean()
            .optional()
            .describe(
              "Send the first prompt asynchronously without waiting for a response",
            ),
        },

        async execute(args, toolCtx) {
          try {
            const targetDirectory = args.directory || toolCtx.directory

            // Get current session context (agent and model) to inherit if not provided
            const msgs = await ctx.client.session.messages({
              path: { id: toolCtx.sessionID },
              query: { directory: toolCtx.directory },
            })
            const lastAssistant = msgs.data
              .filter((m) => m.info.role === "assistant")
              .pop()

            const inheritedAgent = (lastAssistant?.info as any)?.agent
            const inheritedModelID = (lastAssistant?.info as any)?.modelID
            const inheritedProviderID = (lastAssistant?.info as any)?.providerID
            const inheritedSystem = (lastAssistant?.info as any)?.system
            const inheritedTools = (lastAssistant?.info as any)?.tools
              ? JSON.stringify((lastAssistant?.info as any).tools)
              : undefined

            switch (args.mode) {
              case "message":
                // Store message for session.idle handler
                pendingMessages.set(toolCtx.sessionID, {
                  agent: args.agent || inheritedAgent,
                  modelID: args.modelID || inheritedModelID,
                  providerID: args.providerID || inheritedProviderID,
                  system: args.system || inheritedSystem,
                  tools: args.tools || inheritedTools,
                  text: args.text,
                  directory: targetDirectory,
                })
                return args.agent
                  ? `Message sent to ${args.agent} agent. They will respond in this conversation.`
                  : "Message sent. Awaiting response in this conversation."

              case "new":
                // Create session via SDK for agent control
                const newSession = await ctx.client.session.create({
                  query: { directory: targetDirectory },
                  body: {
                    title:
                      args.title ||
                      (args.agent || inheritedAgent
                        ? `Session via ${args.agent || inheritedAgent}`
                        : "New session"),
                  },
                })

                const agent = args.agent || inheritedAgent || "build"
                const system = args.system || inheritedSystem
                const tools = args.tools || inheritedTools

                // Send first message with specified agent
                if (args.async) {
                  await ctx.client.session.promptAsync({
                    path: { id: newSession.data.id },
                    query: { directory: targetDirectory },
                    body: {
                      agent,
                      model:
                        args.modelID || inheritedModelID
                          ? {
                              modelID: args.modelID || inheritedModelID,
                              providerID:
                                args.providerID || inheritedProviderID,
                            }
                          : undefined,
                      system,
                      tools: tools ? JSON.parse(tools) : undefined,
                      parts: [{ type: "text", text: args.text }],
                    },
                  })
                } else {
                  await ctx.client.session.prompt({
                    path: { id: newSession.data.id },
                    query: { directory: targetDirectory },
                    body: {
                      agent,
                      model:
                        args.modelID || inheritedModelID
                          ? {
                              modelID: args.modelID || inheritedModelID,
                              providerID:
                                args.providerID || inheritedProviderID,
                            }
                          : undefined,
                      system,
                      tools: tools ? JSON.parse(tools) : undefined,
                      parts: [{ type: "text", text: args.text }],
                    },
                  })
                }

                return args.async
                  ? `New session created with ${agent} agent (async prompt, ID: ${newSession.data.id})`
                  : `New session created with ${agent} agent (ID: ${newSession.data.id})`

              case "compact":
                try {
                  // Use inherited or provided model info for compaction
                  const providerID = args.providerID || inheritedProviderID
                  const modelID = args.modelID || inheritedModelID

                  if (!providerID || !modelID) {
                    return "Error: No assistant messages found in session. Cannot determine model for compaction."
                  }

                  // Inject context marker that survives compaction
                  await ctx.client.session.prompt({
                    path: { id: toolCtx.sessionID },
                    query: { directory: targetDirectory },
                    body: {
                      noReply: true,
                      parts: [
                        {
                          type: "text",
                          text: args.agent
                            ? `[Session will compact after this response - ${args.agent} agent will continue]`
                            : "[Session will compact after this response]",
                        },
                      ],
                    },
                  })

                  // Store compaction request (will be processed on session.idle)
                  pendingCompactions.set(toolCtx.sessionID, {
                    providerID,
                    modelID,
                    agent: args.agent || inheritedAgent,
                    system: args.system || inheritedSystem,
                    tools: args.tools || inheritedTools,
                    text: args.text,
                    directory: targetDirectory,
                  })

                  // Return immediately - compaction happens after agent finishes naturally
                  return args.agent
                    ? `I'll compact the session after completing this response, then hand off to ${args.agent}.`
                    : `I'll compact the session after completing this response.`
                } catch (error) {
                  throw error // Re-throw to be caught by outer try-catch
                }

              case "fork":
                // Use OpenCode's built-in fork API to copy message history
                const forkedSession = await ctx.client.session.fork({
                  path: { id: toolCtx.sessionID },
                  query: { directory: targetDirectory },
                  body: {},
                })

                if (args.title) {
                  await ctx.client.session.update({
                    path: { id: forkedSession.data.id },
                    query: { directory: targetDirectory },
                    body: { title: args.title },
                  })
                }

                const forkedAgent = args.agent || inheritedAgent || "build"
                const forkedSystem = args.system || inheritedSystem
                const forkedTools = args.tools || inheritedTools

                // Send new message in forked session
                if (args.async) {
                  await ctx.client.session.promptAsync({
                    path: { id: forkedSession.data.id },
                    query: { directory: targetDirectory },
                    body: {
                      agent: forkedAgent,
                      model:
                        args.modelID || inheritedModelID
                          ? {
                              modelID: args.modelID || inheritedModelID,
                              providerID:
                                args.providerID || inheritedProviderID,
                            }
                          : undefined,
                      system: forkedSystem,
                      tools: forkedTools ? JSON.parse(forkedTools) : undefined,
                      parts: [{ type: "text", text: args.text }],
                    },
                  })
                } else {
                  await ctx.client.session.prompt({
                    path: { id: forkedSession.data.id },
                    query: { directory: targetDirectory },
                    body: {
                      agent: forkedAgent,
                      model:
                        args.modelID || inheritedModelID
                          ? {
                              modelID: args.modelID || inheritedModelID,
                              providerID:
                                args.providerID || inheritedProviderID,
                            }
                          : undefined,
                      system: forkedSystem,
                      tools: forkedTools ? JSON.parse(forkedTools) : undefined,
                      parts: [{ type: "text", text: args.text }],
                    },
                  })
                }

                return args.async
                  ? `Forked session with ${forkedAgent} agent (async prompt) - history preserved (ID: ${forkedSession.data.id})`
                  : `Forked session with ${forkedAgent} agent - history preserved (ID: ${forkedSession.data.id})`
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            // Show toast to user
            await ctx.client.tui.showToast({
              body: {
                message: `Session operation failed: ${message}`,
                variant: "error",
              },
            })

            // Return error to agent
            return `Error: ${message}`
          }
        },
      }),
      session_title: tool({
        description: "Set the title for the current session",
        args: {
          title: tool.schema.string().describe("New title for the session"),
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Target session ID (defaults to current session)"),
          directory: tool.schema
            .string()
            .optional()
            .describe(
              "Project directory for the session (defaults to current session directory)",
            ),
        },
        async execute(args, toolCtx) {
          try {
            const targetDirectory = args.directory || toolCtx.directory
            const targetSessionID = args.sessionID || toolCtx.sessionID

            await ctx.client.session.update({
              path: { id: targetSessionID },
              query: { directory: targetDirectory },
              body: { title: args.title },
            })

            return `Session title updated (ID: ${targetSessionID})`
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            await ctx.client.tui.showToast({
              body: {
                message: `Session title update failed: ${message}`,
                variant: "error",
              },
            })

            return `Error: ${message}`
          }
        },
      }),
      session_list: tool({
        description: "List sessions with their status",
        args: {
          directory: tool.schema
            .string()
            .optional()
            .describe(
              "Project directory for listing sessions (defaults to current session directory)",
            ),
        },
        async execute(args, toolCtx) {
          try {
            const targetDirectory = args.directory || toolCtx.directory

            const [sessions, status] = await Promise.all([
              ctx.client.session.list({
                query: { directory: targetDirectory },
              }),
              ctx.client.session.status({
                query: { directory: targetDirectory },
              }),
            ])

            if (!sessions.data.length) {
              return "No sessions found."
            }

            const statusMap = status.data || {}
            const sortedSessions = [...sessions.data].sort(
              (a, b) => b.time.updated - a.time.updated,
            )

            const lines = sortedSessions.map((session) => {
              const sessionStatus = formatSessionStatus(statusMap[session.id])
              return `${session.id} ${sessionStatus} ${session.title} (${session.directory})`
            })

            return lines.join("\n")
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            await ctx.client.tui.showToast({
              body: {
                message: `Session list failed: ${message}`,
                variant: "error",
              },
            })

            return `Error: ${message}`
          }
        },
      }),
      session_last_message: tool({
        description: "Get the last message for a session",
        args: {
          sessionID: tool.schema
            .string()
            .optional()
            .describe("Target session ID (defaults to current session)"),
          directory: tool.schema
            .string()
            .optional()
            .describe(
              "Project directory for the session (defaults to current session directory)",
            ),
        },
        async execute(args, toolCtx) {
          try {
            const targetDirectory = args.directory || toolCtx.directory
            const targetSessionID = args.sessionID || toolCtx.sessionID

            const messages = await ctx.client.session.messages({
              path: { id: targetSessionID },
              query: { directory: targetDirectory },
            })

            if (!messages.data.length) {
              return "No messages found."
            }

            const sortedMessages = [...messages.data].sort(
              (a, b) => a.info.time.created - b.info.time.created,
            )
            const lastMessage = sortedMessages[sortedMessages.length - 1]

            const textParts = lastMessage.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)

            const text = textParts.length
              ? textParts.join("\n")
              : "(no text content)"

            return `Last message (${lastMessage.info.role}) [${lastMessage.info.id}]:\n${text}`
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            await ctx.client.tui.showToast({
              body: {
                message: `Session message lookup failed: ${message}`,
                variant: "error",
              },
            })

            return `Error: ${message}`
          }
        },
      }),
      project_list: tool({
        description: "List available projects and directories",
        args: {
          directory: tool.schema
            .string()
            .optional()
            .describe(
              "Project directory for listing projects (defaults to current session directory)",
            ),
        },
        async execute(args, toolCtx) {
          try {
            const targetDirectory = args.directory || toolCtx.directory
            const projects = await ctx.client.project.list({
              query: { directory: targetDirectory },
            })

            if (!projects.data.length) {
              return "No projects found."
            }

            const lines = projects.data.map((project) => {
              const isCurrent = project.id === ctx.project.id
              const marker = isCurrent ? "*" : " "
              const vcs = project.vcs ? ` (${project.vcs})` : ""
              return `${marker} ${project.worktree} [${project.id}]${vcs}`
            })

            return lines.join("\n")
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            await ctx.client.tui.showToast({
              body: {
                message: `Project list failed: ${message}`,
                variant: "error",
              },
            })

            return `Error: ${message}`
          }
        },
      }),
    },
  }
}
