// The WhatsApp message templates Launchpad sends. WhatsApp only lets a business start a
// conversation with a template that Meta has approved, so each message we send first is one of
// these. They are created in Twilio's Content API and submitted to Meta from there
// (scripts/whatsapp-templates.mjs).
//
// Every button opens https://<PUBLIC_HOST>/go/<path>, which redirects to the right page of the
// right site: WhatsApp buttons need one fixed domain, and our sites each have their own.
import { env } from './env.mjs';

const GO = `${env.publicUrl || 'https://launchpad.aloysjehwin.com'}/go/`;
const VERSION = 'v1';

const cta = (body, title, urlVar) => ({ 'twilio/call-to-action': { body, actions: [{ type: 'URL', title, url: `${GO}{{${urlVar}}}` }] } });

/** key -> { name, category, language, variables (samples Meta reviews), types } */
export const TEMPLATES = {
  previewReady: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'sunrise-tiffin-center/preview' },
    types: cta('Hi {{1}}, this is Launchpad. The website for {{2}} that we are building on your call is ready to watch. Open the live preview and tell us on the call what you would like changed.', 'Open live preview', 3),
  },
  siteLive: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'sunrise-tiffin-center.launchpad.aloysjehwin.com', 4: 'sunrise-tiffin-center' },
    types: cta('Good news, {{1}}. The website for {{2}} is now live at {{3}} and ready to share with your customers. Visitors can talk to an AI assistant on the site that knows your business.', 'Open my website', 4),
  },
  adminAccess: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'sunrise-tiffin-center/admin/sample-private-code' },
    types: cta('Hi {{1}}, this is your private link to manage the website for {{2}}. Use it to see enquiries from your visitors and reply to them. Please keep this link to yourself.', 'Open my dashboard', 3),
  },
  detailsNeeded: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'your opening hours and your shop address', 4: 'sunrise-tiffin-center/details/sample-private-code' },
    types: cta('Hi {{1}}, thank you for your call with Launchpad. To finish the website for {{2}} we still need a few details: {{3}}. Please fill in the short form and your site will be updated right away.', 'Fill in the details', 4),
  },
  newEnquiry: {
    category: 'UTILITY',
    variables: { 1: 'Sunrise Tiffin Center', 2: 'Ravi', 3: 'Do you take party orders for thirty people next Friday?', 4: 'sunrise-tiffin-center/admin/sample-private-code' },
    types: cta('You have a new enquiry for {{1}}. {{2}} asked: {{3}} Open your dashboard to see the full conversation and reply.', 'View enquiry', 4),
  },
  enquiryReply: {
    category: 'UTILITY',
    variables: { 1: 'Ravi', 2: 'Sunrise Tiffin Center', 3: 'Yes, we can cater for thirty people on Friday. Please call us to confirm the menu.', 4: 'sunrise-tiffin-center' },
    types: cta('Hello {{1}}, thank you for contacting {{2}}. Here is their reply to your enquiry: {{3}} You can reach them again through their website.', 'Visit website', 4),
  },
  callMissed: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'sunrise-tiffin-center/callme/sample-private-code' },
    types: cta('Hi {{1}}, this is Launchpad. We tried to call you about the website for {{2}} but could not reach you. Tap the button when you are free and our assistant will call you back straight away.', 'Call me now', 3),
  },
  callSummary: {
    category: 'UTILITY',
    variables: { 1: 'Asha', 2: 'Sunrise Tiffin Center', 3: 'a one-page site with your menu highlights, opening time and a call button', 4: 'sunrise-tiffin-center/admin/sample-private-code' },
    types: cta('Thank you for your call, {{1}}. Here is what we set up for {{2}}: {{3}}. You can ask for changes at any time from your dashboard.', 'Open my dashboard', 4),
  },
};

for (const [key, t] of Object.entries(TEMPLATES)) {
  t.key = key;
  t.language = 'en';
  t.name = `launchpad_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_${VERSION}`;
}

/** WhatsApp rejects parameters with line breaks, tabs or runs of spaces. */
export const param = (value, max = 300) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max) || '-';
