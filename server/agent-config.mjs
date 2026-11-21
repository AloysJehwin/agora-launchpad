// Everything that defines *who the agent is* lives here: persona, greeting, models, voice.
// The product idea plugs in by editing `persona` and, later, adding tools (see the note at the bottom).

export const AGENT_UID = 1001;

export const persona = {
  name: 'Companion',
  greeting: 'Hi, I am your voice companion. What can I help you get done today?',
  failureMessage: 'Sorry, I lost my train of thought. Could you say that again?',
  instructions: [
    'You are a voice-first companion that helps people with everyday tasks.',
    'You are speaking out loud, so answer in one or two short sentences of plain spoken English.',
    'Never use markdown, lists, emoji, or symbols that cannot be read aloud.',
    'Ask one clarifying question at a time when something is ambiguous.',
    'Before doing anything that changes the user\'s data, say what you are about to do and confirm.',
    'If you cannot do something yet, say so plainly instead of pretending.',
  ].join(' '),
};

/**
 * Builds the body for POST /v2/projects/{appid}/join.
 * ASR and LLM run in Agora managed mode (Agora supplies the credentials); TTS is Murf Falcon on your key.
 */
export function buildJoinBody({ env, channel, token, userUid }) {
  const llmCommon = {
    system_messages: [{ role: 'system', content: persona.instructions }],
    greeting_message: persona.greeting,
    failure_message: persona.failureMessage,
    max_history: 32,
    params: { model: env.llmModel },
  };
  const llm = env.llmKey
    ? { url: env.llmUrl, api_key: env.llmKey, ...llmCommon }
    : { credential_mode: 'managed', vendor: 'openai', style: 'openai', url: 'https://api.openai.com/v1/chat/completions', ...llmCommon };

  return {
    name: `companion-${channel}-${Date.now()}`,
    properties: {
      channel,
      token,
      agent_rtc_uid: String(AGENT_UID),
      remote_rtc_uids: [String(userUid)],
      enable_string_uid: false,
      // The agent leaves on its own this many seconds after the user is gone.
      idle_timeout: 60,
      // RTM carries live transcripts, agent state, errors and latency metrics to the browser.
      advanced_features: { enable_rtm: true },
      parameters: { data_channel: 'rtm', enable_error_message: true, enable_metrics: true },
      asr: {
        credential_mode: 'managed',
        vendor: 'deepgram',
        params: { url: 'wss://api.deepgram.com/v1/listen', model: 'nova-3', language: 'en-US' },
      },
      llm,
      tts: {
        vendor: 'murf',
        params: {
          api_key: env.murfKey,
          base_url: env.murfWs,
          voiceId: env.murfVoice,
          locale: env.murfLocale,
          rate: 0,
          pitch: 0,
          model: 'FALCON',
          sample_rate: 24000,
        },
      },
    },
  };
}

// Tools: when the workflow is chosen, expose its actions on an MCP server and attach it with
//   llm.mcp_servers = [{ name, transport: 'streamable_http', endpoint, allowed_tools: [...] }]
// plus advanced_features.enable_tools = true. See "MCP server integration" in Agora's join reference.
