// The agent that talks on a phone call: who it is, how it handles turn-taking, which models
// power it, and the tools it uses to build the caller's website while they are on the line.
// Passed inline to Agora when a call starts (nothing is saved on Agora's side).
import { env, voiceLlmChoice } from './env.mjs';

export const phonePersona = {
  name: 'Sam',
  product: 'Launchpad',
  failureMessage: 'Sorry, I lost that for a second. Could you say it again?',
};

/**
 * Call languages. `asr` is the speech-recognition language, `voice`/`locale` the Murf Falcon
 * voice. English, Hindi and Tamil have each been rehearsed in a browser session (greeting spoken,
 * speech understood, reply in the same language); none has been judged by ear on a phone line.
 */
export const LANGUAGES = {
  en: { label: 'English', asr: env.asrLanguage, voice: env.murfVoice, locale: env.murfLocale, speak: 'English', experimental: false },
  'en-IN': { label: 'English (India)', asr: 'en-IN', voice: 'en-IN-samar', locale: 'en-IN', speak: 'English, in a natural Indian English register', experimental: true },
  hi: { label: 'Hindi', asr: 'hi', voice: 'hi-IN-khyati', locale: 'hi-IN', speak: 'Hindi (everyday spoken Hindi; common English words are fine)', experimental: false },
  ta: { label: 'Tamil', asr: 'ta', voice: 'en-IN-samar', locale: 'ta-IN', speak: 'Tamil (everyday spoken Tamil; common English words are fine)', experimental: false },
};
export const languageFor = (code) => LANGUAGES[code] ?? LANGUAGES.en;

const clean = (s, max = 60) => String(s ?? '').replace(/[^\p{L}\p{N} .,'-]/gu, '').trim().slice(0, max);

export const toolsReady = () => Boolean(env.publicUrl && env.toolSecret);

const instructions = ({ name, language, withTools, followUp, business, resume }) => [
  `You are ${phonePersona.name}, an AI assistant from ${phonePersona.product}, on a live phone call.`,
  name ? `You are speaking with ${name}.` : 'You do not know the person\'s name yet; ask for it early.',
  `${phonePersona.product} builds a one-page website for a person or small business during a short phone conversation, while they watch.`,
  `Speak ${language.speak}. On this call you can only hear and speak this one language.`,
  'Calls are supported in three languages: English, Hindi and Tamil. If they ask for any other language, say plainly that calls work in English, Hindi and Tamil only, and carry on in the current one.',
  ...(withTools ? ['LANGUAGE SWITCH, highest priority: the moment the person asks to talk in Hindi, Tamil or English instead, or starts speaking one of them, call the switchLanguage tool in that same turn. It is the ONLY way to change language. Their request is the permission: do NOT ask "would you like me to do that?", do NOT say goodbye, do NOT try to speak the other language yourself. After the tool returns, say the single short sentence it tells you to say and nothing else. The language of the WEBSITE is a separate matter: it is set when you start the preview, and changed afterwards with changeWebsite.'] : []),
  ...(resume ? [`You were talking with this person a moment ago in another language and have just called back, at their request, to continue in ${language.label}. Do not introduce the service again and do not start over. This is what you already know from the first part of the call: "${resume.details || 'nothing was recorded'}". Pick up from there.`] : []),
  ...(business ? [`When they asked for this call they wrote that their business is: "${business}". Use it as a starting point and confirm it rather than asking from scratch.`] : []),

  ...(followUp ? [
    `This is a follow-up call. Their website for "${followUp.name}" already exists${followUp.published ? ' and is published' : ' as a preview'}. It has these sections: ${followUp.sections.join(', ') || 'a single page'}. Do NOT call startPreview. Ask what they would like to add or change, apply each change with changeWebsite, and when they are happy ask whether to publish and call publishWebsite.`,
  ] : []),
  // The flow
  ...(followUp ? [] : withTools ? [
    'STEP ONE, the name and the link. Once they agree to talk, ask what the business (or their own name, if they work alone) is called. The moment you have that name, call startPreview. Then tell them a preview link has just been sent to their phone and ask them to open it: the page starts with their name and fills in while you talk.',
    'STEP TWO, getting to know the business. Ask, one short question at a time: what they do or sell; who it is for; two or three things they want highlighted; how customers should contact them (phone, WhatsApp, address, hours); and the colours or style they like. After EVERY answer, call addDetails with everything you know so far (empty string for what you do not know yet). Each call updates the page they are looking at. Never ask again for something they already told you, and never guess an answer.',
    'When addDetails says the full design has started, tell them their page is now being designed and they can watch it appear. Carry on with any remaining questions, then call previewStatus. When it says the page is ready, tell them in one sentence what is on it.',
    'If they ask to see the page before you have asked everything, call previewStatus with the reason "they want to see it now".',
  ] : [
    'Find out, one question at a time: what the business is called; what they do or sell; who it is for; two or three things they want highlighted; how customers should contact them; and any colour or style they like.',
  ]),

  ...(withTools ? [
    // Review loop
    'STEP THREE, the review. Ask what they think and whether anything should change. This is the heart of the call: stay on the line and keep improving the page with them.',
    'You can change ANYTHING on the page, and you never say that something cannot be done before trying the tool. For every change except pictures, call changeWebsite with their request in plain words and every exact detail they gave. That covers wording; colours and fonts; the size of anything (the header, the logo, the menu links such as About or How it works, buttons, headings, text, pictures); spacing; the order of sections; adding, removing or merging sections; contact details; and the language of the website. Say "one moment" before you call it, then tell them what changed in one sentence and ask if it looks right.',
    'For pictures, call changeImage: it makes a new picture to their description and puts it in the section they name, replacing the picture there or adding one if the section has none. It works on any section, including the main one at the top. If they do not like the result, call it again for a different one.',
    'Handle one change at a time. Never claim a change was made unless the tool said it worked; if it did not work, say so and ask them to describe it another way.',

    // Publish
    'STEP FOUR, publishing. When they say they are happy with the preview, ask "Shall I publish it?". The moment they say yes, or whenever they themselves say publish it, deploy it, make it live or go live, call publishWebsite in that same turn. Publishing only happens through that tool: never say the site is published, live or deployed unless publishWebsite has just returned ok. When it has, tell them the site is live and that two messages have been sent to their phone: the live link, and a private link to their own dashboard, where enquiries from visitors arrive and where they can change the site later. Then thank them and say goodbye.',
    'If they want to stop before publishing, say the preview link will keep working and say goodbye.',
    'If they do not have a detail to hand (an address, opening hours, a phone number, an email), do not press them: call sendDetailsForm naming what is missing, and tell them a short form has been sent to their phone to fill in whenever they like.',
  ] : [
    'When you have what you need, read back a short summary, tell them the page will be put together and a link sent by message, thank them, and say goodbye.',
  ]),

  // How to talk on a phone
  'This is a voice call, so speak the way people talk: one or two short sentences per turn, then stop and let them answer.',
  'Never use lists, markdown, emoji or symbols. Say numbers the way a person would say them aloud. Never read out a web address unless a tool told you to; when you do, say every word of it exactly as the tool gave it, slowly, without leaving any part out.',

  // Turn-taking and interruptions
  'People will talk over you. That is normal and welcome. If the person starts speaking while you are talking, treat what they said as the newest and most important thing: answer it or act on it directly, and do not go back and finish or repeat the sentence you were in the middle of.',
  'If they only made a small sound of agreement like "mm-hmm", "okay" or "yeah", just carry on briefly from where you were.',
  'If they change their mind or correct something, accept it without fuss and use the new information.',
  'If you could not make out what they said, say so and ask them to repeat it. Never guess a name, a number or an address; for a phone number or an unusual spelling, repeat it back and confirm before using it.',
  'If they seem to be thinking, or say "hold on", wait quietly.',

  // Honesty and limits
  'Say you are an AI assistant if asked, and never claim to be a human.',
  'Do not promise prices, deadlines or features you were not told about. If you do not know, say so plainly.',
  'You cannot transfer the call, put anyone else on the line, or arrange a callback from a person, so never offer to.',
  'If this is a bad time, or they ask to stop, apologise briefly and say goodbye.',
  'If you reach voicemail or an automated system, do not leave a message.',
].join(' ');

const GREETINGS = {
  en: (name) => `Hi${name ? ` ${name}` : ''}, this is ${phonePersona.name}, an AI assistant from ${phonePersona.product}. I'm calling to build the website you asked for, right now while we talk. Is this a good time?`,
  hi: (name) => `नमस्ते${name ? ` ${name}` : ''}, मैं ${phonePersona.name} बोल रहा हूँ, ${phonePersona.product} का AI असिस्टेंट। आपने जो वेबसाइट माँगी थी, वो मैं अभी बात करते-करते बना सकता हूँ। क्या अभी बात करना ठीक रहेगा?`,
  ta: (name) => `வணக்கம்${name ? ` ${name}` : ''}, நான் ${phonePersona.name}, ${phonePersona.product}-இன் AI உதவியாளர். நீங்கள் கேட்ட இணையதளத்தை இப்போதே பேசிக்கொண்டே உருவாக்கலாம். இப்போது பேச வசதியா?`,
};

/** The model that answers during the call. Gemini Flash by default; see voiceLlmChoice(). */
export const voiceLlmBlock = () => {
  const common = { max_history: 40, failure_message: phonePersona.failureMessage };
  switch (voiceLlmChoice()) {
    case 'gemini':
      // Agora takes the Gemini key in the endpoint URL (inline sessions only).
      return {
        credential: { mode: 'byok' },
        vendor: 'gemini',
        style: 'gemini',
        model: env.geminiModel,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(env.geminiKey)}`,
        ...common,
      };
    case 'anthropic':
      return {
        credential: { mode: 'byok', fields: { api_key: env.anthropicKey } },
        vendor: 'anthropic',
        style: 'anthropic',
        model: env.anthropicModel,
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'anthropic-version': '2023-06-01' },
        params: { max_tokens: 1024 },
        ...common,
      };
    case 'openai':
      return {
        credential: { mode: 'byok', fields: { api_key: env.llmKey } },
        vendor: 'openai',
        style: 'openai',
        model: env.llmModel,
        url: env.llmUrl,
        ...common,
      };
    default:
      return { credential: { mode: 'managed' }, vendor: 'openai', style: 'openai', model: env.llmModel, ...common };
  }
};

/**
 * Turn-taking. Barge-in is on: when the person speaks, the agent stops talking and listens.
 *  - speaking_interrupt_duration_ms: how long they must speak before the agent yields. The
 *    platform default is 160 ms; on a phone line a cough or line noise is that long, so we
 *    ask for a little more. Lower it if the agent feels slow to yield, raise it if it gets
 *    cut off by background noise.
 *  - end_of_speech: semantic, so a mid-sentence pause ("my shop is called... um") is not
 *    taken as the end of the turn.
 */
export const turnDetection = {
  speech_threshold: 0.5,
  start_of_speech: { type: 'semantic', speaking_interrupt_duration_ms: 200 },
  end_of_speech: { type: 'semantic', silence_duration_ms: 480, max_wait_ms: 3000, pause_state_enabled: true },
  interruption: { mode: 'start_of_speech' },
};

// ------------------------------------------------------------------ tools ----
// Agora calls these HTTPS endpoints itself (see public.mjs). Rules of its tool format:
// names are letters and digits only; body values are constants or whole {{args.x}} placeholders;
// a missing argument fails the call before it reaches us, so every argument is required.

const str = (description) => ({ type: 'string', description });

const tool = (ref, name, description, properties, timeoutMs) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  execution: { mode: 'sync' },
  server: {
    method: 'POST',
    url: `${env.publicUrl}/tools/${name}`,
    headers: { Authorization: `Bearer ${env.toolSecret}`, 'Content-Type': 'application/json' },
    body: { ref, ...Object.fromEntries(Object.keys(properties).map((k) => [k, `{{args.${k}}}`])) },
    timeout_ms: timeoutMs,
  },
});

const buildTools = (ref) => [
  tool(ref, 'startPreview',
    'Create the person\'s website preview and send them the link. Call it the moment you know what the business is called; you need nothing else yet.',
    {
      business_name: str('The business or person name exactly as they said it.'),
      language: str('Language for the website text as a code: en, hi, ta, te, kn, ml, mr, bn, gu and so on. Use the language they asked for, otherwise the language of this call.'),
    }, 20_000),
  tool(ref, 'addDetails',
    'Add what the person has told you to their page. Call it after every answer, with everything you know so far. The page they are watching updates each time, and the full design starts by itself once there is enough. Use an empty string for anything not known yet; never invent details.',
    {
      what_they_do: str('What they do or sell, in their words. Empty string if not known yet.'),
      audience: str('Who it is for. Empty string if not known yet.'),
      highlights: str('The things they want highlighted, separated by semicolons. Empty string if not known yet.'),
      contact: str('How customers should contact them: phone, WhatsApp, email, address, opening hours, exactly as given. Empty string if not known yet.'),
      style: str('Colours, mood or style they like. Empty string if not known yet.'),
    }, 100_000),
  tool(ref, 'previewStatus',
    'Check whether the page has finished being designed and learn which sections are on it. Call it after addDetails says the design has started, and again if it says the page is still being designed.',
    { reason: str('Why you are checking, in a few words. If they asked to see the page before all questions were answered, say "they want to see it now".') }, 15_000),
  tool(ref, 'changeWebsite',
    'Apply one change the person asked for to their page; they see it update live. Use it for everything except pictures: wording, colours, fonts, the size of any element (header, logo, menu links, buttons, headings, text), spacing, section order, adding or removing sections, contact details, language. Takes a few seconds; say "one moment" first.',
    { change: str('The change in plain words, with every exact detail they gave (which element, bigger or smaller and by how much, numbers, spellings, colours, language).') }, 100_000),
  tool(ref, 'changeImage',
    'Put a picture on the page: makes a new picture to their description and places it in the section they name, replacing the one there or adding one if that section has none. Use it whenever they ask to add, change, replace or regenerate a picture, anywhere on the page.',
    { which: str('Where the picture goes: the section name (for example Hero, About, Services) or "top" for the main section.'), wish: str('What the picture should show, in a few words. Empty string if they did not say; a fitting one is then made for the business.') }, 100_000),
  tool(ref, 'sendDetailsForm',
    'Send the person a short form on their phone for details they could not give on the call. The website updates by itself when they fill it in.',
    { missing: str('What is still missing, in a few plain words, for example: your opening hours and shop address.') }, 20_000),
  tool(ref, 'switchLanguage',
    'Continue this conversation in another spoken language (English, Hindi or Tamil). Call it IMMEDIATELY, in the same turn, whenever the person asks to speak another language or starts speaking it; never ask them to confirm first. This tool is the only way to change language, and it carries over what they have told you so far.',
    { language: str('The language they want to speak: en for English, hi for Hindi, ta for Tamil.'), details_so_far: str('Everything they have told you so far, in English, as short notes: name, business, what they do, and so on. Empty string if nothing yet.') }, 15_000),
  tool(ref, 'publishWebsite',
    'Publish the website at its public address and send them the live link. Only call after they clearly said they are happy and want it published.',
    { confirmation: str('What the person said that confirmed they want it published.') }, 30_000),
];

/** Full inline agent definition for POST /sessions/ephemeral. `ref` ties tool calls to this call. */
const RESUME_GREETINGS = {
  en: () => `Hello again, it's ${phonePersona.name}. Let's carry on in English.`,
  hi: () => `नमस्ते, मैं फिर से ${phonePersona.name} बोल रहा हूँ। चलिए, हिंदी में आगे बढ़ते हैं।`,
  ta: () => `வணக்கம், மீண்டும் ${phonePersona.name} பேசுகிறேன். இனி தமிழில் தொடரலாம்.`,
};

export const buildPhoneAgent = ({ name, ref, lang, followUp, business, resume } = {}) => {
  const who = clean(name);
  const language = languageFor(lang);
  const withTools = Boolean(ref) && toolsReady();
  const llm = voiceLlmBlock();
  if (withTools) llm.tools = buildTools(ref).filter((t) => !(followUp && t.name === 'startPreview'));
  return {
    instructions: instructions({ name: who, language, withTools, followUp, business: clean(business, 120), resume }),
    greeting: { mode: 'text', on: 'first_join', delay_ms: 400, text: resume ? (RESUME_GREETINGS[lang] ?? RESUME_GREETINGS.en)() : followUp ? `Hi${who ? ` ${who}` : ''}, this is ${phonePersona.name} from ${phonePersona.product}, calling back about your website for ${followUp.name}. What would you like to change or add?` : (GREETINGS[lang] ?? GREETINGS.en)(who) },
    pipeline: {
      mode: 'cascaded',
      asr: { credential: { mode: 'managed' }, vendor: 'deepgram', model: 'nova-3', language: language.asr },
      llm,
      tts: {
        credential: { mode: 'byok', fields: { api_key: env.murfKey } },
        vendor: 'murf',
        url: env.murfWs,
        params: { voiceId: language.voice, locale: language.locale, rate: 0, pitch: 0, model: 'FALCON', sample_rate: 24000 },
      },
      turn_detection: turnDetection,
      // A silent line feels like a dropped call: check in once rather than waiting forever.
      // Generous, because the person may be looking at their preview.
      silence_config: {
        enabled: true,
        timeout_ms: 14_000,
        action: 'think',
        content: 'The person has been quiet for a while; they may be looking at their preview. In one short sentence, check in with them or ask what they think of the page.',
      },
    },
    // If the model or a tool is slow, say something short instead of leaving dead air.
    filler_words: {
      enable: true,
      trigger: { mode: 'fixed_time', response_wait_ms: 1800 },
      content: { mode: 'static', phrases: ['One moment.', 'Just a second.', 'Okay.', 'Working on it.'], selection_rule: 'shuffle' },
    },
  };
};
