---
summary: "Skills system — configurable prompt templates with variable substitution for quick actions."
read_when:
  - Creating and using skills
  - Understanding prompt templates
  - Configuring quick actions
title: "Skills"
---

# Skills

Skills are reusable prompt templates with variable substitution. They appear as quick actions in the chat input, letting you trigger common workflows with a single click.

## What are skills?

A skill is a markdown prompt template that can include:

- **Variables** using `{{variable}}` syntax for dynamic substitution
- **Frontmatter metadata** for configuration (name, description, icon)
- **Multi-step instructions** that guide the agent through complex workflows

## Creating skills

### From the Options page

1. Open **Options** → **Agent** tab group → **Skills**
2. Click **Add Skill**
3. Define the skill with a name, description, and prompt template

### Skill format

Skills use markdown with YAML frontmatter:

```markdown
---
name: Code Review
description: Review code for bugs, security issues, and improvements
icon: magnifying-glass
---

Review the following code for:
1. Bugs and logical errors
2. Security vulnerabilities
3. Performance improvements
4. Code style and readability

{{code}}
```

## Variable substitution

Use `{{variableName}}` placeholders that are filled in when the skill is triggered:

```markdown
---
name: Translate
description: Translate text to a target language
---

Translate the following text to {{language}}:

{{text}}
```

When triggered, ChromeClaw prompts for the values of `language` and `text` before sending the expanded prompt.

## Using skills

Skills appear as quick actions in the chat input area. Click a skill to activate it:

1. If the skill has variables, you'll be prompted to fill them in
2. The expanded prompt is sent to the agent
3. The agent processes it like any other message

## Storage

Skills are stored as workspace files in IndexedDB. They can be:

- **Global** — Available to all agents
- **Agent-specific** — Only available to a particular agent

## Example skills

### Daily journal
```markdown
---
name: Daily Journal
description: Create a structured daily journal entry
---

Create a daily journal entry for today. Include:
- Key accomplishments
- Challenges faced
- Tomorrow's priorities
- Any lessons learned

Based on our conversations today, what were the main topics and outcomes?
```

### Explain code
```markdown
---
name: Explain Code
description: Get a detailed explanation of code
---

Explain this code in detail:
- What does it do?
- How does it work step by step?
- What are the key design decisions?
- Are there any potential issues?

{{code}}
```

### Suggested actions

In addition to skills, ChromeClaw supports configurable **suggested actions** — quick-action buttons shown below the chat input. These are simpler than skills (no variable substitution) and are managed on the Options page under **Settings** → **Actions**.
