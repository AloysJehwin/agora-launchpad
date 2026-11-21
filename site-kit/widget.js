/* global AgoraRTC, AgoraRTM */
// Launchpad site assistant: the "Talk to us" button every published site gets.
// One static file, no build step. Loaded as <script src="/_lp/widget.js" defer>.
//
//   Talk   a voice conversation with the business's AI assistant (Agora RTC carries the audio,
//          RTM carries the live transcript and the assistant's state)
//   Write  a short written enquiry
//
// Everything renders inside one Shadow DOM host, so the page's CSS cannot reach in and ours
// cannot leak out. Server and transcript text only ever goes through textContent.
(() => {
  'use strict';

  // The same script is injected into the live preview iframe: no UI there.
  try { if (window.self !== window.top) return; } catch { return; }
  const LOADED = Symbol.for('lp.widget');
  if (window[LOADED]) return;
  window[LOADED] = true;

  const API = '/_lp/api';
  const VENDOR = { rtc: '/_lp/vendor/agora-rtc.js', rtm: '/_lp/vendor/agora-rtm.js' };
  const KEYS = { visitor: 'lp_visitor', dismissed: 'lp_widget_dismissed', lang: 'lp_widget_lang', back: 'lp_widget_return' };
  const TRANSCRIPT_GAP_MS = 2000; // at most one transcript request per two seconds
  const RECONNECT_GIVE_UP_MS = 20000;
  const noop = () => {};

  // ---------------------------------------------------------------- strings ----

  const STR = {
    en: {
      talkToUs: 'Talk to us',
      messageUs: 'Message us',
      hide: 'Hide this button',
      close: 'Close',
      subtitleVoice: 'AI voice assistant',
      subtitleWrite: 'Leave a message',
      tabs: 'How would you like to reach us?',
      tabTalk: 'Talk',
      tabWrite: 'Write',
      language: 'Language',
      disclosure: 'This is an AI assistant for {name}. The conversation is shared with the business so they can get back to you.',
      start: 'Start talking',
      micNote: 'Your browser will ask to use your microphone.',
      interruptNote: 'You can interrupt the assistant at any time. Just start talking.',
      google: 'Use my Google details',
      visitor: 'Using your details: {who}',
      remove: 'Remove',
      connecting: 'Connecting…',
      connectingHint: 'Allow the microphone if your browser asks.',
      cancel: 'Cancel',
      listening: 'Listening',
      listeningHint: 'Go ahead, the assistant is listening.',
      thinking: 'Thinking',
      thinkingHint: 'One moment.',
      speaking: 'Speaking',
      speakingHint: 'Just start talking to interrupt.',
      mutedHint: 'Your microphone is muted. The assistant cannot hear you.',
      mute: 'Mute',
      unmute: 'Unmute',
      end: 'End',
      you: 'You',
      assistant: 'Assistant',
      transcript: 'Conversation so far',
      transcriptEmpty: 'What you and the assistant say will appear here.',
      transcriptOff: 'The live transcript is unavailable. You can still talk and listen.',
      endsIn: 'Ends in {time}',
      secondsLeft: '{n} seconds left',
      tapToHear: 'Tap to hear the assistant',
      reconnecting: 'Connection lost. Reconnecting…',
      ended: 'The conversation has ended.',
      endedAssistant: 'The assistant ended the conversation.',
      endedTime: 'The conversation reached its time limit.',
      endedNetwork: 'The connection dropped and the conversation ended.',
      talkAgain: 'Talk again',
      writeInstead: 'Write a message instead',
      micDenied: 'The microphone is blocked for this site, so the assistant cannot hear you. Allow it in your browser settings and try again, or write your message here.',
      micMissing: 'No microphone was found on this device. Please write your message here instead.',
      micFailed: 'We could not use your microphone. Please write your message here instead.',
      busy: 'The assistant is busy right now. Please write a message instead.',
      unavailable: 'The voice assistant is not available right now. Please write a message instead.',
      startFailed: 'We could not start the conversation. Check your connection and try again, or write a message instead.',
      trouble: 'The assistant is having trouble. You can keep trying, or write a message instead.',
      name: 'Your name',
      phone: 'Phone number',
      email: 'Email',
      optional: 'optional',
      message: 'Message',
      writeNote: 'Your message goes to {name} so they can get back to you.',
      send: 'Send message',
      sending: 'Sending…',
      needName: 'Please enter your name.',
      needPhone: 'Please enter your phone number.',
      badPhone: 'Please enter a valid phone number (7 to 15 digits).',
      badEmail: 'Please check the email address.',
      needMessage: 'Please write your message.',
      sendFailed: 'We could not send your message. Check your connection and try again.',
      sentTitle: 'Message sent',
      sentBody: 'Thank you. {name} will get back to you.',
      sendAnother: 'Write another message',
    },
    hi: {
      talkToUs: 'हमसे बात करें',
      messageUs: 'संदेश भेजें',
      hide: 'यह बटन छिपाएँ',
      close: 'बंद करें',
      subtitleVoice: 'एआई वॉइस असिस्टेंट',
      subtitleWrite: 'संदेश छोड़ें',
      tabs: 'आप हमसे कैसे संपर्क करना चाहेंगे?',
      tabTalk: 'बोलें',
      tabWrite: 'लिखें',
      language: 'भाषा',
      disclosure: 'यह {name} का एआई असिस्टेंट है। यह बातचीत व्यवसाय के साथ साझा की जाती है ताकि वे आपसे संपर्क कर सकें।',
      start: 'बात शुरू करें',
      micNote: 'आपका ब्राउज़र माइक्रोफ़ोन इस्तेमाल करने की अनुमति माँगेगा।',
      interruptNote: 'आप असिस्टेंट को कभी भी बीच में रोक सकते हैं। बस बोलना शुरू करें।',
      google: 'मेरी Google जानकारी इस्तेमाल करें',
      visitor: 'आपकी जानकारी: {who}',
      remove: 'हटाएँ',
      connecting: 'कनेक्ट हो रहा है…',
      connectingHint: 'ब्राउज़र पूछे तो माइक्रोफ़ोन की अनुमति दें।',
      cancel: 'रद्द करें',
      listening: 'सुन रहा है',
      listeningHint: 'बोलिए, असिस्टेंट सुन रहा है।',
      thinking: 'सोच रहा है',
      thinkingHint: 'एक क्षण।',
      speaking: 'बोल रहा है',
      speakingHint: 'बीच में रोकने के लिए बस बोलना शुरू करें।',
      mutedHint: 'आपका माइक्रोफ़ोन म्यूट है। असिस्टेंट आपको सुन नहीं सकता।',
      mute: 'म्यूट करें',
      unmute: 'अनम्यूट करें',
      end: 'समाप्त करें',
      you: 'आप',
      assistant: 'असिस्टेंट',
      transcript: 'अब तक की बातचीत',
      transcriptEmpty: 'आप और असिस्टेंट जो कहेंगे, वह यहाँ दिखेगा।',
      transcriptOff: 'लाइव ट्रांसक्रिप्ट उपलब्ध नहीं है। आप फिर भी बोल और सुन सकते हैं।',
      endsIn: '{time} में समाप्त होगी',
      secondsLeft: '{n} सेकंड बाकी',
      tapToHear: 'असिस्टेंट को सुनने के लिए टैप करें',
      reconnecting: 'कनेक्शन टूट गया। दोबारा जोड़ा जा रहा है…',
      ended: 'बातचीत समाप्त हो गई।',
      endedAssistant: 'असिस्टेंट ने बातचीत समाप्त कर दी।',
      endedTime: 'बातचीत की समय सीमा पूरी हो गई।',
      endedNetwork: 'कनेक्शन टूट गया और बातचीत समाप्त हो गई।',
      talkAgain: 'फिर से बात करें',
      writeInstead: 'इसके बजाय संदेश लिखें',
      micDenied: 'इस साइट के लिए माइक्रोफ़ोन बंद है, इसलिए असिस्टेंट आपको सुन नहीं सकता। ब्राउज़र की सेटिंग में अनुमति देकर फिर कोशिश करें, या अपना संदेश यहाँ लिखें।',
      micMissing: 'इस डिवाइस पर कोई माइक्रोफ़ोन नहीं मिला। कृपया अपना संदेश यहाँ लिखें।',
      micFailed: 'हम आपका माइक्रोफ़ोन इस्तेमाल नहीं कर सके। कृपया अपना संदेश यहाँ लिखें।',
      busy: 'असिस्टेंट अभी व्यस्त है। कृपया इसके बजाय संदेश लिखें।',
      unavailable: 'वॉइस असिस्टेंट अभी उपलब्ध नहीं है। कृपया इसके बजाय संदेश लिखें।',
      startFailed: 'बातचीत शुरू नहीं हो सकी। अपना इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें, या संदेश लिखें।',
      trouble: 'असिस्टेंट को दिक्कत आ रही है। आप फिर कोशिश कर सकते हैं, या संदेश लिख सकते हैं।',
      name: 'आपका नाम',
      phone: 'फ़ोन नंबर',
      email: 'ईमेल',
      optional: 'वैकल्पिक',
      message: 'संदेश',
      writeNote: 'आपका संदेश {name} को भेजा जाएगा ताकि वे आपसे संपर्क कर सकें।',
      send: 'संदेश भेजें',
      sending: 'भेजा जा रहा है…',
      needName: 'कृपया अपना नाम लिखें।',
      needPhone: 'कृपया अपना फ़ोन नंबर लिखें।',
      badPhone: 'कृपया सही फ़ोन नंबर लिखें (7 से 15 अंक)।',
      badEmail: 'कृपया ईमेल पता जाँच लें।',
      needMessage: 'कृपया अपना संदेश लिखें।',
      sendFailed: 'आपका संदेश भेजा नहीं जा सका। अपना इंटरनेट कनेक्शन जाँचकर फिर कोशिश करें।',
      sentTitle: 'संदेश भेज दिया गया',
      sentBody: 'धन्यवाद। {name} आपसे संपर्क करेंगे।',
      sendAnother: 'एक और संदेश लिखें',
    },
    ta: {
      talkToUs: 'எங்களுடன் பேசுங்கள்',
      messageUs: 'செய்தி அனுப்புங்கள்',
      hide: 'இந்தப் பொத்தானை மறை',
      close: 'மூடு',
      subtitleVoice: 'AI குரல் உதவியாளர்',
      subtitleWrite: 'செய்தி விடுங்கள்',
      tabs: 'எங்களை எப்படித் தொடர்பு கொள்ள விரும்புகிறீர்கள்?',
      tabTalk: 'பேசு',
      tabWrite: 'எழுது',
      language: 'மொழி',
      disclosure: 'இது {name} நிறுவனத்தின் AI உதவியாளர். அவர்கள் உங்களைத் தொடர்பு கொள்ள, இந்த உரையாடல் அந்த நிறுவனத்துடன் பகிரப்படும்.',
      start: 'பேசத் தொடங்குங்கள்',
      micNote: 'உங்கள் உலாவி மைக்ரோஃபோனைப் பயன்படுத்த அனுமதி கேட்கும்.',
      interruptNote: 'உதவியாளர் பேசும்போது எப்போது வேண்டுமானாலும் குறுக்கிடலாம். பேசத் தொடங்கினால் போதும்.',
      google: 'என் Google விவரங்களைப் பயன்படுத்து',
      visitor: 'உங்கள் விவரங்கள்: {who}',
      remove: 'நீக்கு',
      connecting: 'இணைக்கிறது…',
      connectingHint: 'உலாவி கேட்டால் மைக்ரோஃபோனை அனுமதியுங்கள்.',
      cancel: 'ரத்து செய்',
      listening: 'கேட்கிறது',
      listeningHint: 'பேசுங்கள், உதவியாளர் கேட்கிறது.',
      thinking: 'யோசிக்கிறது',
      thinkingHint: 'ஒரு நிமிடம்.',
      speaking: 'பேசுகிறது',
      speakingHint: 'குறுக்கிட, பேசத் தொடங்குங்கள்.',
      mutedHint: 'உங்கள் மைக்ரோஃபோன் அணைக்கப்பட்டுள்ளது. உதவியாளரால் உங்களைக் கேட்க முடியாது.',
      mute: 'மைக்கை அணை',
      unmute: 'மைக்கை இயக்கு',
      end: 'முடிக்கவும்',
      you: 'நீங்கள்',
      assistant: 'உதவியாளர்',
      transcript: 'இதுவரை நடந்த உரையாடல்',
      transcriptEmpty: 'நீங்களும் உதவியாளரும் பேசுவது இங்கே தோன்றும்.',
      transcriptOff: 'நேரடி எழுத்துப் பதிவு கிடைக்கவில்லை. இருந்தாலும் நீங்கள் பேசலாம், கேட்கலாம்.',
      endsIn: '{time} இல் முடியும்',
      secondsLeft: '{n} வினாடிகள் மீதம்',
      tapToHear: 'உதவியாளரைக் கேட்க தட்டவும்',
      reconnecting: 'இணைப்பு துண்டிக்கப்பட்டது. மீண்டும் இணைக்கிறது…',
      ended: 'உரையாடல் முடிந்தது.',
      endedAssistant: 'உதவியாளர் உரையாடலை முடித்தார்.',
      endedTime: 'உரையாடலின் நேர வரம்பு முடிந்தது.',
      endedNetwork: 'இணைப்பு துண்டிக்கப்பட்டதால் உரையாடல் முடிந்தது.',
      talkAgain: 'மீண்டும் பேசுங்கள்',
      writeInstead: 'அதற்குப் பதிலாக செய்தி எழுதுங்கள்',
      micDenied: 'இந்தத் தளத்திற்கு மைக்ரோஃபோன் தடுக்கப்பட்டுள்ளது, அதனால் உதவியாளரால் உங்களைக் கேட்க முடியாது. உலாவி அமைப்புகளில் அனுமதி அளித்து மீண்டும் முயலுங்கள், அல்லது உங்கள் செய்தியை இங்கே எழுதுங்கள்.',
      micMissing: 'இந்தச் சாதனத்தில் மைக்ரோஃபோன் இல்லை. தயவுசெய்து உங்கள் செய்தியை இங்கே எழுதுங்கள்.',
      micFailed: 'உங்கள் மைக்ரோஃபோனைப் பயன்படுத்த முடியவில்லை. தயவுசெய்து உங்கள் செய்தியை இங்கே எழுதுங்கள்.',
      busy: 'உதவியாளர் இப்போது வேறு உரையாடலில் உள்ளார். தயவுசெய்து அதற்குப் பதிலாக செய்தி எழுதுங்கள்.',
      unavailable: 'குரல் உதவியாளர் இப்போது கிடைக்கவில்லை. தயவுசெய்து அதற்குப் பதிலாக செய்தி எழுதுங்கள்.',
      startFailed: 'உரையாடலைத் தொடங்க முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயலுங்கள், அல்லது செய்தி எழுதுங்கள்.',
      trouble: 'உதவியாளருக்குச் சிக்கல் ஏற்பட்டுள்ளது. மீண்டும் முயலலாம், அல்லது செய்தி எழுதலாம்.',
      name: 'உங்கள் பெயர்',
      phone: 'தொலைபேசி எண்',
      email: 'மின்னஞ்சல்',
      optional: 'விருப்பம்',
      message: 'செய்தி',
      writeNote: 'உங்கள் செய்தி {name} நிறுவனத்திற்கு அனுப்பப்படும்; அவர்கள் உங்களைத் தொடர்பு கொள்வார்கள்.',
      send: 'செய்தியை அனுப்பு',
      sending: 'அனுப்புகிறது…',
      needName: 'உங்கள் பெயரை எழுதுங்கள்.',
      needPhone: 'உங்கள் தொலைபேசி எண்ணை எழுதுங்கள்.',
      badPhone: 'சரியான தொலைபேசி எண்ணை எழுதுங்கள் (7 முதல் 15 இலக்கங்கள்).',
      badEmail: 'மின்னஞ்சல் முகவரியைச் சரிபார்க்கவும்.',
      needMessage: 'உங்கள் செய்தியை எழுதுங்கள்.',
      sendFailed: 'உங்கள் செய்தியை அனுப்ப முடியவில்லை. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயலுங்கள்.',
      sentTitle: 'செய்தி அனுப்பப்பட்டது',
      sentBody: 'நன்றி. {name} உங்களைத் தொடர்பு கொள்வார்கள்.',
      sendAnother: 'மற்றொரு செய்தி எழுதுங்கள்',
    },
  };

  // ------------------------------------------------------------------ style ----

  // Pixel units throughout: rem would follow the page's root font size.
  const CSS = `
.lp {
  all: initial; display: block;
  --lp-bg: #ffffff; --lp-bg2: #f3f3f1; --lp-ink: #16181d; --lp-ink2: #575c66; --lp-line: #dddcd7; --lp-edge: #868b94;
  --lp-btn: #16181d; --lp-on-btn: #ffffff; --lp-ring: rgba(255, 255, 255, .38);
  --lp-live: #0b6e55; --lp-on-live: #ffffff; --lp-danger: #b3261e; --lp-stop: #b3261e; --lp-focus: #1d5fd6;
  --lp-warn-bg: #fdf3e4; --lp-warn-ink: #51340a; --lp-warn-line: #e6c592;
  color-scheme: light;
  font: 400 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", "Noto Sans Tamil", "Nirmala UI", sans-serif;
  color: var(--lp-ink); text-align: start; direction: ltr; letter-spacing: normal; -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: dark) {
  .lp {
    --lp-bg: #1b1d22; --lp-bg2: #272a31; --lp-ink: #f3f3f1; --lp-ink2: #b0b4bd; --lp-line: #3b3f48; --lp-edge: #7f848e;
    --lp-btn: #f3f3f1; --lp-on-btn: #16181d; --lp-ring: rgba(0, 0, 0, .45);
    --lp-live: #56d3aa; --lp-on-live: #06261d; --lp-danger: #ff9a90; --lp-stop: #c4392f; --lp-focus: #8ab4ff;
    --lp-warn-bg: #392d18; --lp-warn-ink: #f6e0ba; --lp-warn-line: #6d5527;
    color-scheme: dark;
  }
}
.lp *, .lp *::before, .lp *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; margin: 0; letter-spacing: inherit; }
button { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--lp-focus); outline-offset: 2px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
svg { flex: none; display: block; }

.launch {
  position: fixed; right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px) + var(--lp-lift, 0px));
  display: flex; align-items: stretch; height: 48px; max-width: calc(100vw - 32px);
  border-radius: 24px; background: var(--lp-btn); color: var(--lp-on-btn);
  box-shadow: 0 0 0 1px var(--lp-ring), 0 8px 24px rgba(0, 0, 0, .26);
  font-size: 15px; font-weight: 600; line-height: 1.2; animation: lp-in .2s ease-out;
}
.launch button { display: inline-flex; align-items: center; border: 0; background: none; color: inherit; min-height: 44px; }
.launch-main { gap: 8px; padding: 0 8px 0 16px; border-radius: 24px 0 0 24px; white-space: nowrap; min-width: 0; }
.launch-main span { overflow: hidden; text-overflow: ellipsis; }
.launch-x { justify-content: center; width: 44px; padding: 0 4px 0 0; border-radius: 0 24px 24px 0; opacity: .72; }
.launch-x:hover, .launch-x:focus-visible { opacity: 1; }

.panel {
  position: fixed; right: calc(16px + env(safe-area-inset-right, 0px));
  bottom: calc(16px + env(safe-area-inset-bottom, 0px) + var(--lp-kb, 0px));
  width: 384px; max-width: calc(100vw - 32px);
  max-height: min(700px, calc(100vh - 32px)); max-height: min(700px, calc(var(--lp-vh, 100dvh) - 32px));
  display: flex; flex-direction: column; overflow: hidden; outline: none;
  background: var(--lp-bg); color: var(--lp-ink); border: 1px solid var(--lp-line); border-radius: 18px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, .3); animation: lp-in .18s ease-out;
}
.head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 8px 8px 18px; flex: none; }
.head-text { flex: 1; min-width: 0; padding-top: 4px; }
.title { margin: 0; font-size: 17px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
.sub { margin: 2px 0 0; font-size: 13px; color: var(--lp-ink2); }
.icon-btn { flex: none; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 12px; background: none; color: var(--lp-ink2); }
.icon-btn:hover { background: var(--lp-bg2); color: var(--lp-ink); }

.tabs { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 0 18px 2px; padding: 4px; border-radius: 14px; background: var(--lp-bg2); }
.tab { min-height: 44px; padding: 6px 10px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 10px; background: none; color: var(--lp-ink2); font-weight: 600; }
.tab[aria-selected="true"] { background: var(--lp-bg); color: var(--lp-ink); box-shadow: 0 0 0 1px var(--lp-line), 0 1px 3px rgba(0, 0, 0, .12); }

.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 18px 18px; }
.stack { display: flex; flex-direction: column; gap: 14px; }
.stack > p { margin: 0; }
.lead { font-size: 15px; }
.note { font-size: 13px; color: var(--lp-ink2); }
.disclosure { padding: 10px 12px; border-radius: 12px; background: var(--lp-bg2); font-size: 14px; }
.who-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0 10px; font-size: 14px; }
.who-row span { min-width: 0; overflow-wrap: anywhere; }
.link { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; padding: 0 2px; border: 0; background: none; font-size: 14px; font-weight: 600; color: var(--lp-ink); text-decoration: underline; text-underline-offset: 3px; }

.field { display: flex; flex-direction: column; gap: 6px; }
.label { font-size: 13px; font-weight: 600; }
.opt { font-weight: 400; color: var(--lp-ink2); }
.input { width: 100%; min-height: 46px; padding: 10px 12px; font-size: 16px; line-height: 1.4; background: var(--lp-bg); color: var(--lp-ink); border: 1px solid var(--lp-edge); border-radius: 12px; }
.input::placeholder { color: var(--lp-ink2); }
textarea.input { min-height: 104px; resize: vertical; }
.input[aria-invalid="true"] { border-color: var(--lp-danger); box-shadow: 0 0 0 1px var(--lp-danger); }
.pick { position: relative; }
.pick select { appearance: none; -webkit-appearance: none; padding-right: 40px; cursor: pointer; }
.pick svg { position: absolute; right: 12px; top: 50%; margin-top: -9px; pointer-events: none; color: var(--lp-ink2); }
.err { margin: 0; font-size: 13px; font-weight: 500; color: var(--lp-danger); }

.btn { min-height: 48px; padding: 10px 16px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid transparent; border-radius: 14px; font-size: 16px; font-weight: 600; line-height: 1.25; text-align: center; }
.btn-primary { background: var(--lp-btn); color: var(--lp-on-btn); }
.btn-quiet { background: var(--lp-bg2); color: var(--lp-ink); border-color: var(--lp-line); }
.btn-quiet[aria-pressed="true"] { border-color: var(--lp-ink); }
.btn-stop { background: var(--lp-stop); color: #ffffff; }
.btn-big { min-height: 64px; border-radius: 20px; font-size: 18px; }
.btn[disabled] { opacity: .62; cursor: default; }

.notice { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; padding: 12px; border: 1px solid var(--lp-warn-line); border-radius: 12px; background: var(--lp-warn-bg); color: var(--lp-warn-ink); font-size: 14px; }
.notice p { margin: 0; }
.notice .btn { background: var(--lp-bg); color: var(--lp-ink); border-color: var(--lp-warn-line); }

.call { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.call > p { margin: 0; }
.orb { --lp-level: 0; position: relative; flex: none; width: 88px; height: 88px; margin: 16px 0 8px; display: grid; place-items: center; border-radius: 50%; background: var(--lp-live); color: var(--lp-on-live); transition: background-color .2s, color .2s; }
.orb::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; opacity: .26; transform: scale(calc(1 + var(--lp-level) * .6)); transition: transform .12s linear; }
.orb svg { position: relative; }
.orb[data-state="speaking"] { background: var(--lp-btn); color: var(--lp-on-btn); }
.orb[data-state="thinking"], .orb[data-state="connecting"], .orb[data-muted="true"] { background: var(--lp-bg2); color: var(--lp-ink2); box-shadow: inset 0 0 0 1px var(--lp-line); }
.orb[data-state="thinking"]::before, .orb[data-state="connecting"]::before { background: var(--lp-ink2); animation: lp-pulse 1.3s ease-in-out infinite; }
.state { font-size: 20px; line-height: 1.3; font-weight: 650; }
.hint { min-height: 21px; font-size: 14px; color: var(--lp-ink2); }
.count { font-size: 14px; font-weight: 650; color: var(--lp-danger); font-variant-numeric: tabular-nums; }
.script { width: 100%; max-height: 184px; margin-top: 6px; overflow-y: auto; overscroll-behavior: contain; padding: 10px 12px; border: 1px solid var(--lp-line); border-radius: 12px; text-align: start; }
.script p { margin: 0; }
.lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.line { display: flex; flex-direction: column; font-size: 14px; overflow-wrap: anywhere; }
.line b { font-size: 12px; font-weight: 650; color: var(--lp-ink2); }
.line[data-final="false"] span { color: var(--lp-ink2); }
.line[data-cut="true"] span::after { content: " …"; }
.controls { width: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }
.controls.one { grid-template-columns: 1fr; }
.call > .btn { width: 100%; }

.done { align-items: center; text-align: center; padding-top: 10px; }
.done .badge { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 50%; background: var(--lp-live); color: var(--lp-on-live); }
.done h3 { margin: 0; font-size: 19px; line-height: 1.3; font-weight: 650; outline: none; }
.done .btn { align-self: stretch; }

@keyframes lp-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes lp-pulse { 0%, 100% { transform: scale(1); opacity: .1; } 50% { transform: scale(1.28); opacity: .24; } }

@media (max-width: 520px) {
  .launch { right: calc(12px + env(safe-area-inset-right, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px) + var(--lp-lift, 0px)); height: 44px; font-size: 14px; }
  .launch-main { padding-left: 14px; }
  .panel {
    left: 0; right: 0; bottom: var(--lp-kb, 0px); width: auto; max-width: none;
    max-height: calc(100vh - 20px); max-height: calc(var(--lp-vh, 100dvh) - 20px);
    border-width: 1px 0 0; border-radius: 20px 20px 0 0;
    padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .launch, .panel { animation: none; }
  .orb { transition: none; }
  .orb::before { transition: none; transform: none; animation: none !important; opacity: calc(.12 + var(--lp-level) * .5); }
}
@media print { .lp { display: none; } }
`;

  const ICON = {
    mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
    micOff: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3', 'M4 4l16 16'],
    chat: ['M4 5h16v11H10l-5 4v-4H4z'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    sound: ['M4 9.5v5h3.5L12 18V6L7.5 9.5H4z', 'M15.5 9a4.5 4.5 0 0 1 0 6', 'M18 6.5a8 8 0 0 1 0 11'],
    dots: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
    stop: ['M6 6h12v12H6z'],
    chevron: ['M6 9l6 6 6-6'],
  };

  // ---------------------------------------------------------------- helpers ----

  const store = {
    get(key) { try { return window.sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.sessionStorage.setItem(key, value); } catch { /* storage is blocked: carry on without it */ } },
    del(key) { try { window.sessionStorage.removeItem(key); } catch { /* same */ } },
  };
  const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const primary = (code) => String(code ?? '').toLowerCase().split(/[-_]/)[0];

  const request = async (path, body, { keepalive = false } = {}) => {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      keepalive,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : ''), { status: res.status, data });
    return data;
  };
  const beacon = (path, body) => {
    const text = JSON.stringify(body);
    try { if (navigator.sendBeacon(API + path, new Blob([text], { type: 'application/json' }))) return; } catch { /* fall through */ }
    try { navigator.sendBeacon(API + path, text); } catch { /* nothing more can be done while the page is closing */ }
  };

  const h = (tag, props, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  };
  const icon = (name, size = 20, width = 2) => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));
    for (const d of ICON[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const shown = (node) => Boolean(node && node.getClientRects().length);

  // ------------------------------------------------- "Use my Google details" ----

  const cleanVisitor = (v) => {
    if (!v || typeof v !== 'object') return null;
    const name = typeof v.name === 'string' ? v.name.trim().slice(0, 100) : '';
    const email = typeof v.email === 'string' ? v.email.trim().slice(0, 200) : '';
    return name || email ? { name, email } : null;
  };

  // Back from sign-in the URL carries #lp_visitor=<base64url JSON { name, email }>.
  // Read it once and take it out of the address bar, leaving any other fragment alone
  // (the page may already have had one: "#menu#lp_visitor=..." or "#a=1&lp_visitor=...").
  const takeVisitorFromHash = () => {
    const hash = window.location.hash;
    const found = /(^#|[&#])lp_visitor=([^&#]*)/.exec(hash);
    if (!found) return null;
    let rest = hash.slice(0, found.index) + (found.index === 0 ? '#' : '') + hash.slice(found.index + found[0].length);
    rest = rest.replace(/^#&/, '#');
    if (rest === '#') rest = '';
    try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + rest); } catch { /* keep going */ }
    try {
      let b64 = decodeURIComponent(found[2]).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bytes = Uint8Array.from(window.atob(b64), (c) => c.charCodeAt(0));
      return cleanVisitor(JSON.parse(new TextDecoder().decode(bytes)));
    } catch { return null; }
  };

  // ------------------------------------------------------------------ config ----

  const canTalk = () => Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);

  const normalise = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const languages = (Array.isArray(raw.languages) ? raw.languages : [])
      .filter((l) => l && typeof l.code === 'string' && l.code)
      .map((l) => ({ code: l.code, label: typeof l.label === 'string' && l.label ? l.label : l.code }));
    let signInUrl = null;
    try {
      const url = raw.google?.signInUrl ? new URL(raw.google.signInUrl, window.location.href) : null;
      if (url && (url.protocol === 'https:' || url.protocol === 'http:')) signInUrl = String(raw.google.signInUrl);
    } catch { /* not a usable URL */ }
    return {
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      lang: typeof raw.lang === 'string' && raw.lang ? raw.lang : 'en',
      languages,
      voice: raw.voice === true && canTalk(),
      greeting: typeof raw.greeting === 'string' ? raw.greeting.trim() : '',
      signInUrl,
    };
  };

  // The browser's language when the assistant speaks it, else the site's own language.
  const pickLanguage = (cfg) => {
    const list = cfg.languages;
    if (!list.length) return cfg.lang;
    const saved = store.get(KEYS.lang);
    if (saved && list.some((l) => l.code === saved)) return saved;
    const wanted = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of wanted) {
      const lower = String(tag ?? '').toLowerCase();
      if (!lower) continue;
      const hit = list.find((l) => l.code.toLowerCase() === lower) ?? list.find((l) => primary(l.code) === primary(lower));
      if (hit) return hit.code;
    }
    const site = list.find((l) => l.code.toLowerCase() === cfg.lang.toLowerCase()) ?? list.find((l) => primary(l.code) === primary(cfg.lang));
    return (site ?? list[0]).code;
  };

  // --------------------------------------------------------------- the widget ----

  const mount = (cfg, arrived) => {
    const state = {
      lang: pickLanguage(cfg),
      open: false,
      mode: cfg.voice ? 'talk' : 'write',
      visitor: arrived ?? cleanVisitor(parse(store.get(KEYS.visitor))),
      talk: null,
      write: { phase: 'form', errors: {}, notice: null },
    };
    const freshTalk = () => ({ phase: 'idle', agent: 'listening', muted: false, notice: null, offerWrite: false, remaining: null, autoplay: false, reconnecting: false, noScript: false, ended: null });
    state.talk = freshTalk();
    let session = null; // the live voice conversation, if any

    const t = (key, vars) => {
      const text = (STR[primary(state.lang)] ?? STR.en)[key] ?? STR.en[key] ?? '';
      const all = { name: cfg.name, ...vars };
      return text.replace(/\{(\w+)\}/g, (_, name) => String(all[name] ?? ''));
    };
    // A message is either one of our own strings ({ k, vars }) or text the server sent ({ text }).
    const say = (m) => (m ? (m.text ?? t(m.k, m.vars)) : '');

    const bound = []; // [node, string key, attribute?] for everything that only changes with the language
    const bind = (node, key, attr) => { bound.push([node, key, attr]); return node; };
    const label = (key) => bind(h('span'), key);

    // ------------------------------------------------------------- elements ----

    const host = document.createElement('lp-widget');
    // Inline and !important, so no page rule (a stray "*" or "body > *" selector) can move or hide the host.
    const pin = {
      position: 'fixed', top: 'auto', left: 'auto', right: '0', bottom: '0', width: '0', height: '0', margin: '0', padding: '0', border: '0',
      display: 'block', float: 'none', overflow: 'visible', visibility: 'visible', opacity: '1', 'z-index': '2147483647',
      transform: 'none', translate: 'none', scale: 'none', rotate: 'none', filter: 'none', 'backdrop-filter': 'none', 'clip-path': 'none', mask: 'none',
      contain: 'none', 'content-visibility': 'visible', 'mix-blend-mode': 'normal', 'pointer-events': 'auto', animation: 'none', transition: 'none',
    };
    for (const [name, value] of Object.entries(pin)) host.style.setProperty(name, value, 'important');
    const shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      shadow.append(h('style', null, CSS));
    }

    const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });

    // Launcher
    const launchMain = h('button', { class: 'launch-main', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => openPanel() },
      icon(cfg.voice ? 'mic' : 'chat', 18), label(cfg.voice ? 'talkToUs' : 'messageUs'));
    const launchHide = bind(h('button', { class: 'launch-x', type: 'button', onclick: () => dismiss() }, icon('x', 16)), 'hide', 'aria-label');
    const launch = h('div', { class: 'launch' }, launchMain, launchHide);

    // Panel head
    const title = h('h2', { class: 'title', id: 'lp-title' }, cfg.name || t('assistant'));
    const sub = h('p', { class: 'sub' });
    const closeBtn = bind(h('button', { class: 'icon-btn', type: 'button', onclick: () => closePanel() }, icon('x', 20)), 'close', 'aria-label');
    const head = h('div', { class: 'head' }, h('div', { class: 'head-text' }, title, sub), closeBtn);

    // Tabs (only when the voice assistant is available)
    let tabs = null;
    let tabTalk = null;
    let tabWrite = null;
    if (cfg.voice) {
      const onKey = (event) => {
        const next = { ArrowRight: 1, ArrowLeft: -1, Home: 'talk', End: 'write' }[event.key];
        if (next == null) return;
        event.preventDefault();
        const mode = typeof next === 'string' ? next : (state.mode === 'talk' ? 'write' : 'talk');
        setMode(mode);
        (mode === 'talk' ? tabTalk : tabWrite).focus();
      };
      tabTalk = h('button', { class: 'tab', type: 'button', role: 'tab', id: 'lp-tab-talk', 'aria-controls': 'lp-pane-talk', onclick: () => setMode('talk'), onkeydown: onKey }, icon('mic', 18), label('tabTalk'));
      tabWrite = h('button', { class: 'tab', type: 'button', role: 'tab', id: 'lp-tab-write', 'aria-controls': 'lp-pane-write', onclick: () => setMode('write'), onkeydown: onKey }, icon('chat', 18), label('tabWrite'));
      tabs = bind(h('div', { class: 'tabs', role: 'tablist' }, tabTalk, tabWrite), 'tabs', 'aria-label');
    }

    const makeNotice = (onWrite) => {
      const text = h('p');
      const action = onWrite ? h('button', { class: 'btn btn-quiet', type: 'button', onclick: onWrite }, label('writeInstead')) : null;
      const box = h('div', { class: 'notice', role: 'alert', hidden: true }, text, action);
      return { box, text, action };
    };
    const makeGoogleLink = () => bind(h('a', { class: 'link', href: cfg.signInUrl, onclick: (event) => { event.preventDefault(); goToGoogle(); } }), 'google');

    // Talk pane ---------------------------------------------------------------
    const talkNotice = makeNotice(() => setMode('write'));
    const langSelect = h('select', { class: 'input', id: 'lp-lang', onchange: () => setLanguage(langSelect.value) },
      ...cfg.languages.map((l) => h('option', { value: l.code, lang: l.code }, l.label)));
    langSelect.value = state.lang;
    const langField = h('div', { class: 'field', hidden: cfg.languages.length < 2 },
      bind(h('label', { class: 'label', for: 'lp-lang' }), 'language'),
      h('div', { class: 'pick' }, langSelect, icon('chevron', 18)));
    const greeting = h('p', { class: 'lead', hidden: !cfg.greeting }, cfg.greeting); // shown as the server sent it
    const disclosure = bind(h('p', { class: 'disclosure' }), 'disclosure');
    const whoText = h('span');
    const whoRow = h('div', { class: 'who-row', hidden: true }, whoText,
      h('button', { class: 'link', type: 'button', onclick: () => forgetVisitor() }, label('remove')));
    const talkGoogle = cfg.signInUrl ? makeGoogleLink() : null;
    const startBtn = h('button', { class: 'btn btn-primary btn-big', type: 'button', onclick: () => startTalk() }, icon('mic', 24), label('start'));
    const idle = h('div', { class: 'stack' }, greeting, langField, disclosure, whoRow, talkGoogle, startBtn,
      h('p', { class: 'note' }, label('micNote'), ' ', label('interruptNote')));

    const orbIcons = { listening: icon('mic', 32), muted: icon('micOff', 32), thinking: icon('dots', 32, 3.4), speaking: icon('sound', 32) };
    const orb = h('div', { class: 'orb', 'aria-hidden': 'true' }, ...Object.values(orbIcons));
    const stateText = h('p', { class: 'state' });
    const hintText = h('p', { class: 'hint' });
    const countText = h('p', { class: 'count', hidden: true });
    const hearBtn = h('button', { class: 'btn btn-primary', type: 'button', hidden: true, onclick: () => resumeAudio() }, icon('sound', 20), label('tapToHear'));
    const linesEl = h('ol', { class: 'lines' });
    const scriptEmpty = h('p', { class: 'note' });
    const script = bind(h('div', { class: 'script', role: 'region', tabindex: '0' }, scriptEmpty, linesEl), 'transcript', 'aria-label');
    const muteIcons = { on: icon('mic', 20), off: icon('micOff', 20) };
    const muteLabel = h('span');
    const muteBtn = h('button', { class: 'btn btn-quiet', type: 'button', 'aria-pressed': 'false', onclick: () => toggleMute() }, muteIcons.on, muteIcons.off, muteLabel);
    const endLabel = h('span');
    const endBtn = h('button', { class: 'btn btn-stop', type: 'button', onclick: () => endTalk(state.talk.phase === 'live' ? 'user' : 'cancel') }, icon('stop', 18), endLabel);
    const liveControls = h('div', { class: 'controls' }, muteBtn, endBtn);
    const againBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => startTalk() }, icon('mic', 20), label('talkAgain'));
    const endedControls = h('div', { class: 'controls one' }, againBtn,
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => setMode('write') }, label('writeInstead')));
    const call = h('div', { class: 'call' }, orb, stateText, hintText, countText, hearBtn, script, liveControls, endedControls);
    const paneTalk = cfg.voice
      ? h('div', { id: 'lp-pane-talk', role: 'tabpanel', 'aria-labelledby': 'lp-tab-talk' }, talkNotice.box, idle, call)
      : null;

    // Write pane --------------------------------------------------------------
    const FIELDS = [
      { id: 'name', type: 'text', autocomplete: 'name', max: 100 },
      { id: 'phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel', max: 30 },
      { id: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', max: 200, optional: true },
      { id: 'message', area: true, max: 2000 },
    ];
    const inputs = {};
    const errors = {};
    const fieldRows = FIELDS.map((f) => {
      const common = { class: 'input', id: `lp-f-${f.id}`, name: f.id, maxlength: f.max, 'aria-describedby': `lp-e-${f.id}`, 'aria-required': f.optional ? null : 'true' };
      const input = f.area
        ? h('textarea', { ...common, rows: '4' })
        : h('input', { ...common, type: f.type, autocomplete: f.autocomplete, inputmode: f.inputmode, autocapitalize: f.id === 'name' ? 'words' : 'off', spellcheck: 'false' });
      input.addEventListener('input', () => {
        if (!state.write.errors[f.id]) return;
        delete state.write.errors[f.id];
        render();
      });
      inputs[f.id] = input;
      errors[f.id] = h('p', { class: 'err', id: `lp-e-${f.id}`, hidden: true });
      const text = h('label', { class: 'label', for: `lp-f-${f.id}` }, label(f.id));
      if (f.optional) text.append(' ', h('span', { class: 'opt' }, '(', label('optional'), ')'));
      return h('div', { class: 'field' }, text, input, errors[f.id]);
    });
    const writeNotice = makeNotice(null);
    const writeGoogle = cfg.signInUrl ? makeGoogleLink() : null;
    const sendLabel = h('span');
    const sendBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, sendLabel);
    const form = h('form', { class: 'stack', novalidate: true, onsubmit: (event) => { event.preventDefault(); submitEnquiry(); } },
      writeGoogle, ...fieldRows, bind(h('p', { class: 'note' }), 'writeNote'), sendBtn);
    const sentTitle = bind(h('h3', { tabindex: '-1' }), 'sentTitle');
    const sent = h('div', { class: 'stack done', hidden: true },
      h('div', { class: 'badge' }, icon('check', 28, 2.6)), sentTitle, bind(h('p'), 'sentBody'),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { state.write.phase = 'form'; render(); inputs.message.focus(); } }, label('sendAnother')));
    const paneWrite = h('div', { id: 'lp-pane-write', role: cfg.voice ? 'tabpanel' : null, 'aria-labelledby': cfg.voice ? 'lp-tab-write' : null }, writeNotice.box, form, sent);

    const panel = h('section', { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'lp-title', tabindex: '-1', hidden: true,
      onkeydown: (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); closePanel(); } } },
    head, tabs, h('div', { class: 'body' }, paneTalk, paneWrite));

    const root = h('div', { class: 'lp' }, live, launch, panel);
    shadow.append(root);

    // --------------------------------------------------------------- render ----

    let lastStatus = '';
    let announceTimer = null;
    const announce = (text) => {
      if (!text) return;
      clearTimeout(announceTimer);
      live.textContent = '';
      announceTimer = setTimeout(() => { live.textContent = text; }, 60);
    };

    const setNotice = (notice, message, offer) => {
      notice.box.hidden = !message;
      setText(notice.text, say(message));
      if (notice.action) notice.action.hidden = !offer;
    };

    const focusFallback = () => {
      const T = state.talk;
      let target = panel;
      if (state.mode === 'write') target = state.write.phase === 'sent' ? sentTitle : (tabWrite ?? panel);
      else if (T.phase === 'idle') target = startBtn;
      else if (T.phase === 'ended') target = againBtn;
      else target = endBtn;
      (shown(target) ? target : panel).focus();
    };

    const render = () => {
      const had = shadow.activeElement;
      const T = state.talk;
      const W = state.write;
      const inCall = T.phase === 'connecting' || T.phase === 'live';

      setAttr(root, 'lang', state.lang);
      for (const [node, key, attr] of bound) attr ? setAttr(node, attr, t(key)) : setText(node, t(key));
      if (!cfg.name) setText(title, t('assistant'));
      setText(sub, t(state.mode === 'talk' ? 'subtitleVoice' : 'subtitleWrite'));

      launch.hidden = state.open;
      panel.hidden = !state.open;
      setAttr(launchMain, 'aria-expanded', String(state.open));

      if (cfg.voice) {
        tabs.hidden = inCall;
        for (const [mode, tab] of [['talk', tabTalk], ['write', tabWrite]]) {
          setAttr(tab, 'aria-selected', String(state.mode === mode));
          tab.tabIndex = state.mode === mode ? 0 : -1;
        }
        paneTalk.hidden = state.mode !== 'talk';
        setNotice(talkNotice, T.notice, T.offerWrite);
        idle.hidden = T.phase !== 'idle';
        call.hidden = T.phase === 'idle';
        if (langSelect.value !== state.lang) langSelect.value = state.lang;

        const who = state.visitor ? [state.visitor.name, state.visitor.email].filter(Boolean).join(' · ') : '';
        whoRow.hidden = !who;
        setText(whoText, who ? t('visitor', { who }) : '');
        if (talkGoogle) talkGoogle.hidden = Boolean(who);

        const view = T.phase === 'connecting' ? 'connecting' : T.agent;
        setAttr(orb, 'data-state', view);
        setAttr(orb, 'data-muted', String(T.phase === 'live' && T.muted));
        orb.hidden = T.phase === 'ended';
        const glyph = T.phase === 'live' && T.muted && view === 'listening' ? 'muted' : (view === 'connecting' ? 'thinking' : view);
        for (const [name, node] of Object.entries(orbIcons)) node.style.display = name === glyph ? '' : 'none';

        let status = '';
        let hint = '';
        if (T.phase === 'connecting') { status = t('connecting'); hint = t('connectingHint'); }
        else if (T.phase === 'live') {
          status = t(T.agent);
          hint = T.reconnecting ? t('reconnecting') : (T.muted ? t('mutedHint') : t(`${T.agent}Hint`));
        } else if (T.phase === 'ended') status = say(T.ended);
        setText(stateText, status);
        setText(hintText, hint);
        hintText.hidden = T.phase === 'ended';
        countText.hidden = !(T.phase === 'live' && T.remaining != null);
        if (T.remaining != null) setText(countText, t('endsIn', { time: `0:${String(T.remaining).padStart(2, '0')}` }));
        hearBtn.hidden = !(T.phase === 'live' && T.autoplay);

        const hasLines = linesEl.childElementCount > 0;
        script.hidden = T.phase === 'connecting' || (T.phase === 'ended' && !hasLines);
        scriptEmpty.hidden = hasLines;
        setText(scriptEmpty, t(T.noScript ? 'transcriptOff' : 'transcriptEmpty'));
        for (const li of linesEl.children) setText(li.firstChild, t(li.dataset.role === 'visitor' ? 'you' : 'assistant'));

        liveControls.hidden = !inCall;
        liveControls.classList.toggle('one', T.phase !== 'live');
        muteBtn.hidden = T.phase !== 'live';
        setAttr(muteBtn, 'aria-pressed', String(T.muted));
        muteIcons.on.style.display = T.muted ? 'none' : '';
        muteIcons.off.style.display = T.muted ? '' : 'none';
        setText(muteLabel, t(T.muted ? 'unmute' : 'mute'));
        setText(endLabel, t(T.phase === 'live' ? 'end' : 'cancel'));
        endedControls.hidden = T.phase !== 'ended';

        const spoken = T.phase === 'live' && T.reconnecting ? hint : status;
        if (state.open && state.mode === 'talk' && spoken && spoken !== lastStatus) announce(spoken);
        lastStatus = state.open && state.mode === 'talk' ? spoken : '';
      }

      paneWrite.hidden = state.mode !== 'write';
      setNotice(writeNotice, W.notice, false);
      form.hidden = W.phase === 'sent';
      sent.hidden = W.phase !== 'sent';
      if (writeGoogle) writeGoogle.hidden = Boolean(state.visitor);
      for (const f of FIELDS) {
        const message = say(W.errors[f.id]);
        errors[f.id].hidden = !message;
        setText(errors[f.id], message);
        setAttr(inputs[f.id], 'aria-invalid', String(Boolean(message)));
      }
      sendBtn.disabled = W.phase === 'sending';
      setAttr(sendBtn, 'aria-busy', String(W.phase === 'sending'));
      setText(sendLabel, t(W.phase === 'sending' ? 'sending' : 'send'));

      // Whatever had the focus may just have been hidden: keep the focus inside the panel.
      if (had && state.open && !shown(had)) focusFallback();
    };

    // --------------------------------------------------------- open / close ----

    const viewport = window.visualViewport;
    // Keep the sheet above the on-screen keyboard where the browser overlays it (iOS).
    const fit = () => {
      if (!state.open) return;
      const plain = !viewport || Math.abs(viewport.scale - 1) > 0.01;
      const height = plain ? window.innerHeight : viewport.height;
      const keyboard = plain ? 0 : Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      panel.style.setProperty('--lp-vh', `${Math.round(height)}px`);
      panel.style.setProperty('--lp-kb', `${Math.round(keyboard)}px`);
    };
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);

    // If the page pins something of its own to the bottom edge under the launcher (a fixed
    // "Order now" bar, say), sit just above it instead of on top of it.
    let dodgeTimer = null;
    const dodge = () => {
      dodgeTimer = null;
      if (state.open || !host.isConnected) return;
      const rect = launch.getBoundingClientRect();
      if (!rect.width) return;
      const lift = parseFloat(launch.style.getPropertyValue('--lp-lift')) || 0;
      const y = rect.top + lift + rect.height / 2; // where the launcher sits when not lifted
      let top = Infinity;
      for (const x of [rect.left + 8, rect.left + rect.width / 2, rect.right - 8]) {
        const under = document.elementsFromPoint(x, y).find((node) => node !== host);
        for (let node = under; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
          if (window.getComputedStyle(node).position !== 'fixed') continue;
          const box = node.getBoundingClientRect();
          if (box.bottom >= window.innerHeight - 48) top = Math.min(top, box.top);
          break;
        }
      }
      let next = Number.isFinite(top) ? Math.ceil(rect.bottom + lift - top + 8) : 0;
      if (next < 0 || next > window.innerHeight * 0.4) next = 0; // too tall to step over: stay put
      launch.style.setProperty('--lp-lift', `${next}px`);
    };
    const queueDodge = () => { dodgeTimer ??= setTimeout(dodge, 200); };
    window.addEventListener('resize', queueDodge);
    window.addEventListener('scroll', queueDodge, { passive: true });

    const openPanel = (mode) => {
      if (mode && (mode === 'write' || cfg.voice)) state.mode = mode;
      state.open = true;
      fit();
      render();
      panel.focus({ preventScroll: true });
    };
    const closePanel = () => {
      if (session) endTalk('cancel');
      if (state.talk.phase === 'ended') state.talk = freshTalk();
      state.open = false;
      render();
      launchMain.focus({ preventScroll: true });
      queueDodge();
    };
    const dismiss = () => {
      store.set(KEYS.dismissed, '1');
      host.remove();
    };
    const setMode = (mode) => {
      if (session || state.mode === mode) return;
      state.mode = mode;
      if (state.talk.phase === 'ended') state.talk = freshTalk();
      state.talk.notice = null;
      if (mode === 'talk') state.write.notice = null;
      render();
    };
    const setLanguage = (code) => {
      if (!cfg.languages.some((l) => l.code === code)) return;
      state.lang = code;
      store.set(KEYS.lang, code);
      render();
    };

    // --------------------------------------------------------------- visitor ----

    const prefill = () => {
      if (!state.visitor) return;
      if (!inputs.name.value) inputs.name.value = state.visitor.name;
      if (!inputs.email.value) inputs.email.value = state.visitor.email;
    };
    const forgetVisitor = () => {
      state.visitor = null;
      store.del(KEYS.visitor);
      render();
    };
    const goToGoogle = () => {
      const draft = {};
      for (const f of FIELDS) draft[f.id] = inputs[f.id].value;
      store.set(KEYS.back, JSON.stringify({ mode: state.mode, draft }));
      // The contract appends '?return='. Use '&' when the sign-in URL already has a query string.
      const joiner = cfg.signInUrl.includes('?') ? '&' : '?';
      window.location.assign(`${cfg.signInUrl}${joiner}return=${encodeURIComponent(window.location.href)}`);
    };

    // --------------------------------------------------------------- enquiry ----

    const validate = (v) => {
      const out = {};
      if (!v.name) out.name = { k: 'needName' };
      const digits = v.phone.replace(/\D/g, '').length;
      if (!v.phone) out.phone = { k: 'needPhone' };
      else if (!/^\+?[\d\s().-]+$/.test(v.phone) || digits < 7 || digits > 15) out.phone = { k: 'badPhone' };
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) out.email = { k: 'badEmail' };
      if (!v.message) out.message = { k: 'needMessage' };
      return out;
    };

    const submitEnquiry = async () => {
      const W = state.write;
      if (W.phase === 'sending') return;
      const values = {};
      for (const f of FIELDS) values[f.id] = inputs[f.id].value.trim();
      W.errors = validate(values);
      W.notice = null;
      const firstBad = FIELDS.find((f) => W.errors[f.id]);
      if (firstBad) {
        render();
        inputs[firstBad.id].focus();
        return;
      }
      W.phase = 'sending';
      render();
      try {
        await request('/enquiry', { ...values, lang: state.lang });
        W.phase = 'sent';
        inputs.message.value = '';
        render();
        sentTitle.focus();
        announce(`${t('sentTitle')}. ${t('sentBody')}`);
      } catch (err) {
        W.phase = 'form';
        const field = err.status === 400 ? err.data?.field : null;
        if (field && inputs[field]) {
          W.errors = { [field]: err.message ? { text: err.message } : { k: field === 'name' ? 'needName' : field === 'phone' ? 'badPhone' : field === 'email' ? 'badEmail' : 'needMessage' } };
          render();
          inputs[field].focus();
        } else {
          W.notice = err.status >= 400 && err.status < 500 && err.message ? { text: err.message } : { k: 'sendFailed' };
          render();
        }
      }
    };

    // ------------------------------------------------------------ voice: SDKs ----

    const loadScript = (src) => new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = () => resolve();
      tag.onerror = () => { tag.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.append(tag);
    });
    let sdks = null;
    // Loaded only when a visitor actually starts a conversation. RTM is optional: audio works without it.
    const loadSdks = () => {
      sdks ??= Promise.all([
        window.AgoraRTC ? null : loadScript(VENDOR.rtc),
        window.AgoraRTM ? null : loadScript(VENDOR.rtm).catch(noop),
      ]).then(() => {
        if (!window.AgoraRTC) throw new Error('AgoraRTC is missing');
        try { AgoraRTC.setLogLevel(3); } catch { /* cosmetic */ }
        // Browsers block audio that starts without a gesture; Agora tells us when that happens.
        AgoraRTC.onAutoplayFailed = () => {
          if (!session || session.dead) return;
          state.talk.autoplay = true;
          render();
        };
      }).catch((err) => { sdks = null; throw err; });
      return sdks;
    };

    // ------------------------------------------------------ voice: transcript ----

    const upsertLine = (s, role, turn, text, { final, cut }) => {
      if (s.dead || !text) return;
      const key = `${role}:${turn}`;
      let line = s.lines.get(key);
      const stick = script.scrollHeight - script.scrollTop - script.clientHeight < 48;
      if (!line) {
        const body = h('span');
        const li = h('li', { class: 'line', 'data-role': role }, h('b', null, t(role === 'visitor' ? 'you' : 'assistant')), body);
        linesEl.append(li);
        line = { role, turn, text: '', li, body };
        s.lines.set(key, line);
        scriptEmpty.hidden = true;
      }
      line.text = String(text);
      setText(line.body, line.text);
      line.li.dataset.final = String(Boolean(final));
      line.li.dataset.cut = String(Boolean(cut));
      if (stick) script.scrollTop = script.scrollHeight;
      if (final) queueLine(s, key, line);
    };

    // Each final line goes to the server once, batched, at most one request per two seconds.
    const queueLine = (s, key, line) => {
      if (s.sent.has(key)) return;
      s.queue.set(key, { role: line.role, text: line.text, turn: line.turn, tries: s.queue.get(key)?.tries ?? 0 });
      scheduleSend(s);
    };
    const scheduleSend = (s) => {
      if (s.dead || s.sendTimer || s.sending || !s.queue.size || !s.talkId) return;
      const wait = Math.max(0, TRANSCRIPT_GAP_MS - (Date.now() - s.lastSend));
      s.sendTimer = setTimeout(() => { s.sendTimer = null; sendLines(s); }, wait);
    };
    const sendLines = (s) => {
      if (!s.queue.size || !s.talkId) return Promise.resolve();
      const batch = [...s.queue];
      s.queue.clear();
      for (const [key] of batch) s.sent.add(key);
      s.lastSend = Date.now();
      const lines = batch.map(([, l]) => ({ role: l.role, text: l.text, turn: l.turn }));
      const sending = request('/talk/transcript', { talkId: s.talkId, lines }, { keepalive: true })
        .catch(() => {
          // Not delivered: put the lines back for the next round, a couple of times at most.
          for (const [key, l] of batch) {
            if (l.tries >= 2 || s.queue.has(key)) continue;
            s.sent.delete(key);
            s.queue.set(key, { ...l, tries: l.tries + 1 });
          }
        })
        .finally(() => {
          if (s.sending === sending) s.sending = null;
          scheduleSend(s);
        });
      s.sending = sending;
      return sending;
    };

    // -------------------------------------------------- voice: agent messages ----

    // Agent state as reported by Agora: idle | silent | listening | thinking | speaking
    const applyAgentState = (s, name) => {
      if (s.dead || !name) return;
      s.statesSeen = true;
      const next = name === 'speaking' || name === 'thinking' ? name : 'listening';
      if (state.talk.agent === next) return;
      state.talk.agent = next;
      render();
    };

    const onAgentMessage = (s, raw) => {
      if (s.dead) return;
      let msg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      // Events arrive without an `object` field: { event_type: 'state.speaking' | ..., payload: { value } }
      if (typeof msg.event_type === 'string') {
        if (msg.event_type.startsWith('state.')) {
          applyAgentState(s, msg.payload?.value === false ? 'listening' : msg.event_type.slice('state.'.length));
        }
        return;
      }
      switch (msg.object) {
        case 'assistant.transcription':
          // turn_status: 0 still speaking, 1 finished, 2 interrupted
          upsertLine(s, 'assistant', msg.turn_id, msg.text, { final: msg.turn_status !== 0, cut: msg.turn_status === 2 });
          break;
        case 'user.transcription':
          upsertLine(s, 'visitor', msg.turn_id, msg.text, { final: Boolean(msg.final) });
          break;
        case 'message.state':
          applyAgentState(s, msg.state);
          break;
        case 'message.error':
          state.talk.notice = { k: 'trouble' };
          state.talk.offerWrite = false;
          render();
          break;
        default:
          break;
      }
    };

    // Transcript and state are a nicety: if RTM fails the conversation carries on by audio alone.
    const startRtm = async (s, grant) => {
      let rtm = null;
      try {
        if (!window.AgoraRTM) throw new Error('AgoraRTM is missing');
        rtm = new AgoraRTM.RTM(grant.appId, String(grant.uid));
        s.rtm = rtm;
        rtm.addEventListener('message', (event) => onAgentMessage(s, event.message));
        rtm.addEventListener('presence', (event) => applyAgentState(s, event.stateChanged?.state));
        await rtm.login({ token: grant.rtmToken });
        if (s.dead) throw new Error('ended');
        await rtm.subscribe(grant.channel);
        if (s.dead) throw new Error('ended');
      } catch {
        if (s.rtm === rtm) s.rtm = null;
        try { Promise.resolve(rtm?.logout()).catch(noop); } catch { /* never logged in */ }
        if (s.dead) return;
        state.talk.noScript = true;
        render();
      }
    };

    // ------------------------------------------------------- voice: lifecycle ----

    const release = (s) => {
      const { mic, rtc, rtm } = s;
      s.mic = null;
      s.rtc = null;
      s.rtm = null;
      s.remote.clear();
      try { mic?.stop(); mic?.close(); } catch { /* already closed */ }
      try { Promise.resolve(rtc?.leave()).catch(noop); } catch { /* never joined */ }
      try { Promise.resolve(rtm?.logout()).catch(noop); } catch { /* never logged in */ }
    };
    const stopTimers = (s) => {
      for (const name of ['tick', 'meter']) { clearInterval(s[name]); s[name] = null; }
      for (const name of ['sendTimer', 'reconnectTimer']) { clearTimeout(s[name]); s[name] = null; }
    };

    const level = (track) => { try { return Number(track?.getVolumeLevel()) || 0; } catch { return 0; } };
    const meter = (s) => {
      if (s.dead) return;
      const you = state.talk.muted ? 0 : level(s.mic);
      let agent = 0;
      for (const track of s.remote.values()) agent = Math.max(agent, level(track));
      orb.style.setProperty('--lp-level', Math.min(1, Math.max(you, agent) * 1.8).toFixed(2));
      // Without RTM there are no state events: read "speaking" off the assistant's audio instead.
      if (!s.statesSeen) {
        if (agent > 0.04) s.lastAgentSound = Date.now();
        const next = Date.now() - s.lastAgentSound < 700 ? 'speaking' : 'listening';
        if (state.talk.agent !== next) { state.talk.agent = next; render(); }
      }
    };
    const tick = (s) => {
      if (s.dead || !s.deadline) return;
      const left = Math.ceil((s.deadline - Date.now()) / 1000);
      if (left <= 0) { endTalk('time'); return; }
      if (left > 30 || state.talk.remaining === left) return;
      state.talk.remaining = left;
      render();
      if (left === 30 || left === 10) announce(t('secondsLeft', { n: left }));
    };

    const failToWrite = (s, message) => {
      // The microphone cannot be used: explain, and put the written form in front of the visitor.
      s.dead = true;
      if (session === s) session = null;
      stopTimers(s);
      if (s.talkId) request('/talk/stop', { talkId: s.talkId }, { keepalive: true }).catch(noop);
      release(s);
      state.talk = freshTalk();
      state.mode = 'write';
      state.write.notice = message;
      if (state.write.phase === 'sent') state.write.phase = 'form';
      render();
    };
    const micMessage = (err) => {
      const code = `${err?.code ?? ''} ${err?.name ?? ''}`;
      if (/PERMISSION_DENIED|NotAllowedError|SecurityError/i.test(code)) return { k: 'micDenied' };
      if (/DEVICE_NOT_FOUND|NotFoundError|OverconstrainedError/i.test(code)) return { k: 'micMissing' };
      return { k: 'micFailed' };
    };

    const startTalk = async () => {
      if (session) return;
      const s = {
        dead: false, live: false, talkId: null, channel: null, uid: null, agentUid: null,
        rtc: null, rtm: null, mic: null, remote: new Map(),
        lines: new Map(), queue: new Map(), sent: new Set(), lastSend: 0, sendTimer: null, sending: null,
        tick: null, meter: null, deadline: 0, reconnectTimer: null, statesSeen: false, lastAgentSound: 0,
      };
      session = s;
      state.talk = { ...freshTalk(), phase: 'connecting' };
      linesEl.replaceChildren();
      orb.style.setProperty('--lp-level', '0');
      render();

      const startFailed = (message, offerWrite = true) => {
        if (s.dead) return;
        s.dead = true;
        if (session === s) session = null;
        stopTimers(s);
        if (s.talkId) request('/talk/stop', { talkId: s.talkId }, { keepalive: true }).catch(noop);
        release(s);
        state.talk = { ...freshTalk(), notice: message, offerWrite };
        render();
      };

      try {
        await loadSdks();
      } catch {
        startFailed({ k: 'startFailed' });
        return;
      }
      if (s.dead) return;

      // 1. Microphone first, so nobody without one starts (and pays for) an assistant session.
      try {
        s.mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
      } catch (err) {
        if (!s.dead) failToWrite(s, micMessage(err));
        return;
      }
      if (s.dead) { release(s); return; }
      try { s.mic.on?.('track-ended', () => { if (!s.dead) { endTalk('cancel'); state.mode = 'write'; state.write.notice = { k: 'micFailed' }; render(); } }); } catch { /* optional */ }

      // 2. Ask the server for a conversation: it brings the assistant into the channel.
      let grant;
      try {
        grant = await request('/talk', { lang: state.lang, visitor: state.visitor ? { name: state.visitor.name, email: state.visitor.email } : null });
      } catch (err) {
        if (err.status === 429) startFailed(err.message ? { text: err.message } : { k: 'busy' });
        else if (err.status === 503) startFailed({ k: 'unavailable' });
        else startFailed({ k: 'startFailed' });
        return;
      }
      if (s.dead) {
        if (grant?.talkId) request('/talk/stop', { talkId: grant.talkId }, { keepalive: true }).catch(noop);
        release(s);
        return;
      }
      Object.assign(s, { talkId: grant.talkId, channel: grant.channel, uid: grant.uid, agentUid: grant.agentUid });
      const maxSeconds = Number(grant.maxSeconds);
      if (Number.isFinite(maxSeconds) && maxSeconds > 0) s.deadline = Date.now() + maxSeconds * 1000;

      // 3. Transcript and agent state over RTM, alongside the audio so the greeting is not missed.
      startRtm(s, grant);

      // 4. Audio: join the channel, play whatever the assistant publishes, publish the microphone.
      try {
        const rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        s.rtc = rtc;
        rtc.on('user-published', async (user, mediaType) => {
          if (mediaType !== 'audio') return;
          try {
            await rtc.subscribe(user, mediaType);
            if (s.dead || !user.audioTrack) return;
            s.remote.set(String(user.uid), user.audioTrack);
            user.audioTrack.play();
          } catch { /* the assistant republishes if this was a blip */ }
        });
        rtc.on('user-unpublished', (user, mediaType) => {
          if (mediaType === 'audio') s.remote.delete(String(user.uid));
        });
        rtc.on('user-left', (user) => {
          if (!s.dead && String(user.uid) === String(s.agentUid)) endTalk('assistant');
        });
        rtc.on('connection-state-change', (now, before, reason) => {
          if (s.dead || !s.live) return;
          if (now === 'RECONNECTING') {
            state.talk.reconnecting = true;
            s.reconnectTimer ??= setTimeout(() => endTalk('network'), RECONNECT_GIVE_UP_MS);
            render();
          } else if (now === 'CONNECTED') {
            clearTimeout(s.reconnectTimer);
            s.reconnectTimer = null;
            state.talk.reconnecting = false;
            render();
          } else if (now === 'DISCONNECTED' && reason !== 'LEAVE') {
            endTalk('network');
          }
        });
        rtc.on('token-privilege-did-expire', () => endTalk('time'));
        await rtc.join(grant.appId, grant.channel, grant.rtcToken, grant.uid);
        if (s.dead) { release(s); return; }
        await rtc.publish(s.mic);
        if (s.dead) { release(s); return; }
      } catch {
        startFailed({ k: 'startFailed' });
        return;
      }

      s.live = true;
      state.talk.phase = 'live';
      s.meter = setInterval(() => meter(s), 100);
      s.tick = setInterval(() => tick(s), 250);
      render();
    };

    const END_MESSAGE = { user: 'ended', assistant: 'endedAssistant', time: 'endedTime', network: 'endedNetwork', page: 'ended' };

    const endTalk = (reason, { closing = false } = {}) => {
      const s = session;
      if (!s || s.dead) return;
      s.dead = true;
      session = null;
      stopTimers(s);

      // Nothing more will arrive, so whatever was still being said is as final as it gets.
      for (const [key, line] of s.lines) {
        if (line.text && !s.sent.has(key) && !s.queue.has(key)) s.queue.set(key, { role: line.role, text: line.text, turn: line.turn, tries: 0 });
        line.li.dataset.final = 'true';
      }
      if (s.talkId) {
        const talkId = s.talkId;
        if (closing) {
          // The page is going away: only beacons are sure to leave.
          if (s.queue.size) beacon('/talk/transcript', { talkId, lines: [...s.queue.values()].map((l) => ({ role: l.role, text: l.text, turn: l.turn })) });
          beacon('/talk/stop', { talkId });
        } else {
          Promise.resolve(s.sending)
            .then(() => sendLines(s))
            .then(() => sendLines(s)) // one more go for anything that failed just now
            .then(() => request('/talk/stop', { talkId }, { keepalive: true }))
            .catch(noop);
        }
      }
      release(s);
      orb.style.setProperty('--lp-level', '0');

      if (reason === 'cancel') state.talk = freshTalk();
      else state.talk = { ...freshTalk(), phase: 'ended', noScript: state.talk.noScript, ended: { k: END_MESSAGE[reason] ?? 'ended' } };
      render();
    };

    const toggleMute = async () => {
      const s = session;
      if (!s?.mic || !s.live) return;
      const muted = !state.talk.muted;
      try { await s.mic.setMuted(muted); } catch { return; }
      if (s.dead) return;
      state.talk.muted = muted;
      render();
      announce(t(muted ? 'mutedHint' : 'listeningHint'));
    };

    const resumeAudio = () => {
      const s = session;
      if (!s) return;
      for (const track of s.remote.values()) { try { track.play(); } catch { /* try the next one */ } }
      state.talk.autoplay = false;
      render();
    };

    // Closing the tab should not leave an assistant running until its timeout.
    window.addEventListener('pagehide', () => {
      if (session) endTalk('page', { closing: true });
    });

    // ----------------------------------------------------------------- start ----

    prefill();
    const back = parse(store.get(KEYS.back));
    store.del(KEYS.back);
    render();
    (document.body ?? document.documentElement).append(host);
    queueDodge();
    setTimeout(queueDodge, 1500); // again once late page furniture has settled
    if (arrived && back) {
      // Just back from "Use my Google details": pick up where the visitor left off.
      for (const f of FIELDS) {
        const value = back.draft?.[f.id];
        if (typeof value === 'string' && value) inputs[f.id].value = value.slice(0, f.max);
      }
      prefill();
      openPanel(back.mode === 'write' ? 'write' : 'talk');
    }
  };

  // -------------------------------------------------------------------- boot ----

  const boot = async () => {
    const arrived = takeVisitorFromHash();
    if (arrived) store.set(KEYS.visitor, JSON.stringify(arrived));
    if (store.get(KEYS.dismissed)) return; // hidden for this session

    let cfg = null;
    try {
      const res = await fetch(`${API}/config`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) return;
      cfg = normalise(await res.json());
    } catch {
      return; // no config, no widget
    }
    if (!cfg) return;
    try { mount(cfg, arrived); } catch (err) { console.warn('Launchpad assistant could not start:', err); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
