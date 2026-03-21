import { readFileSync } from 'node:fs';
import type { ManifestType } from '@extension/shared';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * @prop default_locale
 * if you want to support multiple languages, you can use the following reference
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
 *
 * @prop browser_specific_settings
 * Must be unique to your extension to upload to addons.mozilla.org
 * (you can delete if you only want a chrome extension)
 *
 * @prop permissions
 * Firefox doesn't support sidePanel (It will be deleted in manifest parser)
 */
const googleClientId = process.env['CEB_GOOGLE_CLIENT_ID'] ?? '';

const manifest = {
  manifest_version: 3,
  default_locale: 'en',
  name: '__MSG_extensionName__',
  browser_specific_settings: {
    gecko: {
      id: 'chromeclaw-firefox@algopian1.gmail.com',
      strict_min_version: '113.0',
      data_collection_permissions: {
        required: ['none'],
        optional: [],
      },
    },
  },
  version: packageJson.version,
  description: '__MSG_extensionDescription__',
  host_permissions: ['<all_urls>'],
  permissions: [
    'storage',
    'scripting',
    'tabs',
    'notifications',
    'sidePanel',
    'alarms',
    'debugger',
    'offscreen',
    'identity',
    'cookies',
    'declarativeNetRequest',
  ],
  // oauth2 is only included when a Google Cloud client ID is configured.
  // Without it, Chrome rejects the manifest with "Invalid value for 'oauth2.client_id'".
  // Google tools will still work via chrome.identity.getAuthToken({ scopes }) at runtime.
  ...(googleClientId
    ? {
        oauth2: {
          client_id: googleClientId,
          scopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.compose',
            'https://www.googleapis.com/auth/calendar.events.readonly',
            'https://www.googleapis.com/auth/calendar.events',
            'https://www.googleapis.com/auth/drive.metadata.readonly',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.file',
          ],
        },
      }
    : {}),
  declarative_net_request: {
    rule_resources: [
      {
        id: 'whatsapp_origin',
        enabled: true,
        path: 'rules/whatsapp-origin.json',
      },
      {
        id: 'strip_extension_origin',
        enabled: true,
        path: 'rules/strip-extension-origin.json',
      },
    ],
  },
  options_ui: {
    page: 'options/index.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_icon: {
      '16': 'icon-16.png',
      '32': 'icon-32.png',
    },
  },
  icons: {
    '16': 'icon-16.png',
    '32': 'icon-32.png',
    '48': 'icon-48.png',
    '128': 'icon-128.png',
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' https: data: blob:",
  },
  web_accessible_resources: [
    {
      resources: [
        '*.js',
        '*.css',
        '*.svg',
        '*.wasm',
        'icon-128.png',
        'icon-48.png',
        'icon-32.png',
        'icon-16.png',
      ],
      matches: ['*://*/*'],
    },
  ],
  side_panel: {
    default_path: 'side-panel/index.html',
  },
} satisfies ManifestType;

export default manifest;
