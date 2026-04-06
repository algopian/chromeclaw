---
summary: "Google integration tools — Gmail (search, read, send, draft), Calendar (list, create, update, delete), and Drive (search, read, create)."
read_when:
  - Setting up Gmail, Calendar, or Drive integration
  - Using Google services through ChromeClaw
  - Understanding OAuth setup for Google tools
title: "Google Services"
---

# Google Services

ChromeClaw integrates with Gmail, Google Calendar, and Google Drive via OAuth using the `chrome.identity` API. OAuth scopes are requested lazily — only when a tool is first used.

<Note>
Google tools require a `CEB_GOOGLE_CLIENT_ID` environment variable set at build time. If you're using the Chrome Web Store version, this is already configured.
</Note>

## Gmail

Four tools for email management:

### gmail_search

Search emails using Gmail search syntax.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Gmail search query (e.g., `from:alice subject:meeting`) |
| `maxResults` | number | 10 | Maximum results |

Returns a list of messages with: ID, threadId, from, to, subject, date, and snippet.

### gmail_read

Read a full email message.

| Parameter | Type | Description |
|-----------|------|-------------|
| `messageId` | string | (required) Message ID from search results |

Returns the complete message with parsed headers and plain text body.

### gmail_send

Send an email.

| Parameter | Type | Description |
|-----------|------|-------------|
| `to` | string | (required) Recipient email |
| `subject` | string | (required) Email subject |
| `body` | string | (required) Email body |
| `cc` | string | CC recipients |
| `bcc` | string | BCC recipients |

### gmail_draft

Create a draft email (same parameters as `gmail_send`).

---

## Google Calendar

Four tools for calendar management:

### calendar_list

List upcoming events.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `timeMin` | string | — | Start time (ISO 8601) |
| `timeMax` | string | — | End time (ISO 8601) |
| `maxResults` | number | 20 | Maximum events |
| `calendarId` | string | `primary` | Calendar ID |

Returns events with: ID, summary, start/end times, location, description, and attendees.

### calendar_create

Create a new event.

| Parameter | Type | Description |
|-----------|------|-------------|
| `summary` | string | (required) Event title |
| `startTime` | string | (required) Start time (ISO 8601) |
| `endTime` | string | (required) End time (ISO 8601) |
| `description` | string | Event description |
| `location` | string | Event location |
| `attendees` | string | Comma-separated email addresses |

### calendar_update

Update an existing event.

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventId` | string | (required) Event ID |
| `calendarId` | string | Calendar ID |
| `summary` | string | Updated title |
| `startTime` | string | Updated start time |
| `endTime` | string | Updated end time |
| `description` | string | Updated description |
| `location` | string | Updated location |
| `attendees` | string | Updated attendees |

### calendar_delete

Delete an event.

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventId` | string | (required) Event ID |
| `calendarId` | string | Calendar ID |

---

## Google Drive

Three tools for file management:

### drive_search

Search files in Google Drive.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | Drive search query |
| `maxResults` | number | 20 | Maximum results |

Returns files with: ID, name, mimeType, modifiedTime, size, and webViewLink.

### drive_read

Read a file's content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `fileId` | string | (required) File ID from search results |

Google Docs and Sheets are exported as plain text. Other files are downloaded directly (1 MB limit).

### drive_create

Create a new file.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | (required) File name |
| `content` | string | (required) File content |
| `mimeType` | string | MIME type (optional) |
| `folderId` | string | Parent folder ID (optional) |

## OAuth scopes

Scopes are requested incrementally as you use each service:

| Service | Scopes |
|---------|--------|
| Gmail | `gmail.readonly`, `gmail.send`, `gmail.compose` |
| Calendar | `calendar.readonly`, `calendar.events` |
| Drive | `drive.metadata.readonly`, `drive.readonly`, `drive.file` |
