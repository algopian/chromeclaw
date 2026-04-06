---
summary: "Create Document tool — generate text, code, spreadsheet, and image artifacts for display in the chat UI."
read_when:
  - Creating documents and artifacts
  - Understanding artifact types
title: "Documents"
---

# Documents

The `create_document` tool generates artifacts that are displayed in a dedicated viewer in the chat UI. Artifacts support text, code, spreadsheets, and images.

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `title` | string | (required) Document title |
| `kind` | string | (required) Document type: `text`, `code`, `sheet`, `image` |
| `content` | string | (required) Full document content |

## Document types

### Text

Plain text or markdown documents. Rendered with markdown formatting in the artifact viewer.

### Code

Code files with syntax highlighting. The artifact viewer displays the code with language-appropriate highlighting.

### Sheet

Spreadsheet data. Rendered as a table in the artifact viewer.

### Image

Image content (e.g., SVG markup, base64 data). Rendered as an image in the artifact viewer.

## Storage

Artifacts are stored in IndexedDB (`artifacts` table) with:
- Unique ID
- Title
- Kind (text/code/sheet/image)
- Content
- Associated chat ID
- Creation timestamp

Artifacts persist across browser restarts and can be viewed in the chat history.
