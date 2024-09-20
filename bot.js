require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const NDK = require('@nostr-dev-kit/ndk').default;
const { nip19 } = require('nostr-tools');
const WebSocket = require('ws');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {polling: true});

const naddrList = [
  'naddr1qqyrjv33x9jk2enxqyxhwumn8ghj7mn0wvhxcmmvqgsp2c6tc2q02wd68met3q8jm098r45nppxejw2rf0eaa7v3ns8k24grqsqqql95ndwg6z',
  // Add more naddrs here
];

const defaultRelays = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.riginode.xyz',
];

const ndk = new NDK({
  explicitRelayUrls: defaultRelays,
});

async function connectToRelays() {
  try {
    await ndk.connect();
    console.log('Connected to relays:', defaultRelays);
    return true;
  } catch (error) {
    console.error('Failed to connect to relays:', error);
    return false;
  }
}

async function fetchEventDirectly(filter) {
  for (const relay of defaultRelays) {
    try {
      const event = await new Promise((resolve, reject) => {
        const ws = new WebSocket(relay);
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Timeout'));
        }, 10000);

        ws.on('open', () => {
          const subscriptionMessage = JSON.stringify(["REQ", "my-sub", filter]);
          ws.send(subscriptionMessage);
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data);
          if (message[0] === 'EVENT' && message[1] === 'my-sub') {
            clearTimeout(timeout);
            ws.close();
            resolve(message[2]);
          } else if (message[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      if (event) return event;
    } catch (error) {
      console.error(`Error fetching event from relay ${relay}:`, error);
    }
  }
  return null;
}

async function fetchCalendarEvents(calendarId) {
  console.log(`Fetching events for calendar: ${calendarId}`);
  const [kind, pubkey, identifier] = calendarId.split(':');

  const calendarFilter = {
    kinds: [parseInt(kind)],
    authors: [pubkey],
    "#d": [identifier],
  };

  try {
    console.log('Fetching calendar event with filter:', calendarFilter);
    const calendarEvent = await fetchEventDirectly(calendarFilter);

    if (!calendarEvent) {
      throw new Error('Calendar event not found');
    }

    console.log('Calendar event found:', calendarEvent);

    const eventReferences = calendarEvent.tags
      .filter(tag => tag[0] === 'a')
      .map(tag => {
        const [_, eventReference] = tag;
        const [eventKind, eventPubkey, eventIdentifier] = eventReference.split(':');
        return { kind: parseInt(eventKind), pubkey: eventPubkey, identifier: eventIdentifier };
      });

    console.log('Event references:', eventReferences);

    if (eventReferences.length === 0) {
      return { calendarName: calendarEvent.tags.find(t => t[0] === 'name')?.[1] || 'Unbenannter Kalender', events: [] };
    }

    const eventsFilter = {
      kinds: [31923],
      authors: [pubkey],
      "#d": eventReferences.map(ref => ref.identifier),
    };

    console.log('Fetching events with filter:', eventsFilter);
    const events = await fetchEventsDirectly(eventsFilter);
    console.log(`Fetched ${events.length} events for calendar ${calendarId}`);
    return { calendarName: calendarEvent.tags.find(t => t[0] === 'name')?.[1] || 'Unbenannter Kalender', events };
  } catch (error) {
    console.error(`Error fetching events for calendar ${calendarId}:`, error);
    return { calendarName: 'Unbekannter Kalender', events: [] };
  }
}

async function fetchEventsDirectly(filter) {
  const events = [];
  for (const relay of defaultRelays) {
    try {
      const ws = new WebSocket(relay);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve();
        }, 10000);

        ws.on('open', () => {
          const subscriptionMessage = JSON.stringify(["REQ", "my-sub", filter]);
          ws.send(subscriptionMessage);
        });

        ws.on('message', (data) => {
          const message = JSON.parse(data);
          if (message[0] === 'EVENT' && message[1] === 'my-sub') {
            events.push(message[2]);
          } else if (message[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    } catch (error) {
      console.error(`Error fetching events from relay ${relay}:`, error);
    }
  }
  return events;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Willkommen beim Dezentralschweiz Bot! Verwende /meetups, um bevorstehende Meetups zu sehen.');
});

bot.onText(/\/meetups/, async (msg) => {
  const chatId = msg.chat.id;
  
  console.log('Fetching calendar events...');
  try {
    bot.sendMessage(chatId, 'Hole bevorstehende Meetups, bitte warten...');
    
    let allEvents = [];
    for (const naddr of naddrList) {
      const decoded = nip19.decode(naddr);
      const calendarId = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
      const { calendarName, events } = await fetchCalendarEvents(calendarId);
      allEvents.push({ calendarName, events });
    }
    
    if (allEvents.every(cal => cal.events.length === 0)) {
      bot.sendMessage(chatId, 'Keine bevorstehenden Meetups gefunden.');
      return;
    }

    let message = '🗓 *Bevorstehende Meetups*\n\n';
    
    allEvents.forEach(({ calendarName, events }) => {
      if (events.length > 0) {
        message += `*${calendarName}*\n\n`;
        
        const uniqueEvents = events.reduce((acc, event) => {
          const eventId = event.id;
          if (!acc.some(e => e.id === eventId)) {
            acc.push(event);
          }
          return acc;
        }, []);
        
        uniqueEvents.sort((a, b) => {
          const aStart = parseInt(a.tags.find(t => t[0] === 'start')?.[1] || '0');
          const bStart = parseInt(b.tags.find(t => t[0] === 'start')?.[1] || '0');
          return aStart - bStart;
        });
        
        uniqueEvents.forEach((event, index) => {
          const title = event.tags.find(t => t[0] === 'name')?.[1] || 'Unbenanntes Meetup';
          const start = new Date(parseInt(event.tags.find(t => t[0] === 'start')?.[1] || '0') * 1000);
          const location = event.tags.find(t => t[0] === 'location')?.[1] || 'Kein Ort angegeben';
          
          message += `${index + 1}. 🎉 *${title}*\n`;
          message += `   🕒 Datum: ${start.toLocaleString('de-CH')}\n`;
          message += `   📍 Ort: ${location}\n\n`;
        });
        
        message += '\n';
      }
    });
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error in /meetups command:', error);
    bot.sendMessage(chatId, 'Ein Fehler ist beim Holen der Meetups aufgetreten. Bitte versuche es später erneut.');
  }
});

async function main() {
  console.log('Bot is starting...');
  const connected = await connectToRelays();
  if (connected) {
    console.log('Bot is ready to receive commands.');
  } else {
    console.error('Failed to connect to relays. Bot may not function correctly.');
  }
}

main();
