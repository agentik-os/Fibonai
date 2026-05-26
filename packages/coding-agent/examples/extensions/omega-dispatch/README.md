# Omega Dispatch Extension

Bridges Fibonai to the Omega VPS orchestration system. Instead of using API-limited programmatic calls, Fibonai dispatches tasks to **Claude Code workers via tmux sessions** — using OAuth authentication that bypasses rate limits.

## Architecture

```
Fibonai (brain/orchestrator)
  → dispatch_to_claude tool
    → dispatch-to-session.sh (Omega pipeline)
      → tmux session with Claude Code (OAuth auth)
        → Worker executes autonomously
        → Writes done.json + intent-delta
      ← monitor_worker (tmux capture-pane)
    ← collect_result (done.json + intent verification)
  → Fibonai synthesizes and reports
```

## Why This Works

Claude Code CLI uses OAuth authentication (not API keys). When Fibonai creates a tmux session with Claude Code inside, it's a regular interactive CLI session — not programmatic API usage. This means:

- No API token rate limits
- Full Claude Code capabilities (tools, agents, skills)
- Access to the entire Omega ecosystem (281 agents, 130+ skills, Quality Arsenal)
- Workers run autonomously with the Three Laws

## Tools

| Tool | Description |
|------|-------------|
| `dispatch_to_claude` | Spawn a Claude Code worker in a tmux session |
| `monitor_worker` | Check worker status via tmux capture-pane |
| `collect_result` | Read done.json + intent delta for final outcome |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/dispatch <task>` | Quick dispatch a task to Claude Code |
| `/workers` | List all active Fibonai workers |

## Usage

```bash
# Load the extension when starting Fibonai
pi -e ~/.local/share/fibonai/extensions/omega-dispatch/index.ts

# Or add to settings for auto-load
```

## Integration with Omega Wave-4

The extension leverages the full Omega intent pipeline:
1. `intent-parser.sh` extracts structured intent (success criteria, verify commands)
2. Worker receives the full intent in their prompt
3. `intent-verifier.sh` checks delta between intent and reality at close-gate
4. Auto-loop if gap > threshold
