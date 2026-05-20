# Swedish Public Transport for Homey

Real-time departures and arrivals for every Swedish public transport stop — bus, train, tram, metro and ferry — powered by [Trafiklab.se](https://www.trafiklab.se).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Get a Trafiklab API key](#2-get-a-trafiklab-api-key)
3. [Install & configure the app](#3-install--configure-the-app)
4. [Add a Transport Board](#4-add-a-transport-board)
5. [Board settings explained](#5-board-settings-explained)
6. [Flow cards reference](#6-flow-cards-reference)
7. [Gotchas & tips](#7-gotchas--tips)

---

## 1. Prerequisites

- A Homey Pro running firmware 5.0 or later
- A free Trafiklab developer account (see below)

---

## 2. Get a Trafiklab API key

Trafiklab is Sweden's national open-data platform for public transport. The API is **free** — you just need to register.

### Step 1 — Create an account

1. Go to [developer.trafiklab.se](https://developer.trafiklab.se) and click **Register**.
2. Fill in your email, username and password — or sign in with GitHub.
3. Check your inbox and **verify your email address** before continuing (the confirmation link expires after a short while).

### Step 2 — Create a project

1. Log in and click **My projects → New project**.
2. Give it a name (e.g. *My Homey*) and a short description. The other fields are optional.
3. Click **Create project**.

### Step 3 — Add the Realtime API

1. Inside your new project, open the **APIs** dropdown.
2. Find **Trafiklab Realtime APIs** and click **Add API key**.
3. A key is generated immediately and shown in your project.

### Step 4 — Copy the key

Click the key to reveal it in full and copy it. You'll paste it into Homey in the next step.

> **Keep your key private.** It is tied to your account and your usage quota. Don't post it publicly.

---

## 3. Install & configure the app

1. Install **Swedish Public Transport** from the [Homey App Store](https://homey.app).
2. In the Homey app, go to **Settings → Apps → Swedish Public Transport**.
3. Paste your Trafiklab API key into the **API Key** field and tap **Save**.

The app validates the key when you save. If you see a red error, double-check that you copied the key in full with no extra spaces.

---

## 4. Add a Transport Board

Each board represents one stop and shows the next departure (or arrival) matching your filters.

1. In the Homey app go to **Devices → Add device → Swedish Public Transport → Transport Board**.
2. Type the name of a stop in the search box — e.g. *Odenplan*, *Göteborg C* or *Täby centrum*.
3. Select the correct stop from the results list. Transport modes served by the stop are shown as badges.
4. Give the board a friendly name (e.g. *Morning train* or *Bus stop outside*) and tap **Add**.

You can add as many boards as you like — one per stop, or multiple boards for the same stop if you want to track different lines or transport types separately.

---

## 5. Board settings explained

Open a board's settings in the Homey app to configure it.

| Setting | Default | Description |
|---|---|---|
| **Polling interval** | 5 min | How often the board fetches fresh data. Read the [Gotchas](#7-gotchas--tips) section before lowering this. |
| **Show** | Departures | Switch to **Arrivals** to see vehicles arriving at the stop instead of leaving it. |
| **Transport type** | All | Limit the board to one mode: Bus, Train, Tram, Metro or Ferry. |
| **Line filter** | *(empty)* | Show only a specific line, e.g. `14` or `42X`. Case-insensitive partial match. |
| **Destination filter** | *(empty)* | Show only departures towards a specific destination, e.g. `Centralstationen`. Case-insensitive partial match. |

### What you see on the device tile

| Capability | What it shows |
|---|---|
| **Next Departure** | Realtime departure time, or scheduled time if realtime is unavailable |
| **Line** | Line number or name |
| **Destination** | Where the vehicle is heading (in arrivals mode this shows the origin) |
| **Departs in** | Minutes until departure, updated on each poll |
| **Delay** | Minutes late — 0 means on time |
| **Monitoring** | Toggle to pause or resume polling without removing the board |
| **Last Updated** | Timestamp of the most recent successful API call |
| **Status** | API health — *OK*, *No data*, or an error description |

---

## 6. Flow cards reference

### Triggers — When…

| Card | Fires when… |
|---|---|
| **Departure data was updated** | Fresh data arrives on every poll cycle. Use this for display flows and general-purpose automations. |
| **A departure is coming up within X minutes** | The next departure's countdown first drops to or below your chosen threshold. Fires **once per departure** — not on every poll. |
| **A departure is delayed by at least X minutes** | A delay is first detected, or grows beyond your minimum threshold. Fires once when the delay crosses the threshold. |
| **A departure has been cancelled** | The next matching departure becomes cancelled. Fires once per cancellation event. |
| **A departure is back on time** | A previously delayed departure clears its delay. Use this to cancel earlier alerts. |

All trigger cards provide these flow tokens:

| Token | Example |
|---|---|
| `departure_time` | `14:32` — effective time (realtime if available) |
| `scheduled_departure_time` | `14:27` |
| `realtime_departure_time` | `14:32` |
| `line_name` | `14` |
| `destination` | `Centralstationen` |
| `direction` | `towards Centralstationen` |
| `transport_type` | `BUS` / `TRAIN` / `TRAM` / `METRO` / `FERRY` |
| `platform` | `A` |
| `delay_minutes` | `5` |
| `delay_text` | `+5 min late` |
| `is_cancelled` | `true` / `false` |
| `realtime_available` | `true` / `false` |
| `minutes_until_departure` | `8` |
| `stop_name` | `Odenplan` |
| `operator` | `Keolis` |
| `origin` | `Järfälla` |

### Conditions — And…

| Card | True when… |
|---|---|
| **Next departure is / is not delayed** | The next departure has a known positive delay. |
| **Next departure is / is not within X minutes** | The countdown is at or below your chosen number of minutes. |

### Actions — Then…

| Card | What it does |
|---|---|
| **Refresh departure data** | Immediately fetches fresh data outside the normal poll schedule. Useful for on-demand flows. |

---

### Example flows

**Remind me before my morning train**
- **When:** A departure is coming up within **12** minutes *(board: Morning train)*
- **Then:** Send push notification — *"[[line_name]] to [[destination]] departs in [[minutes_until_departure]] min"*

**Alert me when my train is delayed**
- **When:** A departure is delayed by at least **3** minutes *(board: Morning train)*
- **Then:** Send push notification — *"[[line_name]] is [[delay_text]] — new time [[departure_time]]"*

**Clear the delay alert when it's resolved**
- **When:** A departure is back on time *(board: Morning train)*
- **Then:** Send push notification — *"[[line_name]] to [[destination]] is back on time"*

**Turn on the hallway lights when it's almost time to go**
- **When:** A departure is coming up within **5** minutes *(board: Bus stop outside)*
- **And:** Time is between 07:00 and 09:00
- **Then:** Turn on *Hallway light*

**Announce cancellations on a speaker**
- **When:** A departure has been cancelled *(board: Bus stop outside)*
- **Then:** Speak text — *"Heads up — [[line_name]] to [[destination]] at [[scheduled_departure_time]] has been cancelled"*

---

## 7. Gotchas & tips

### Don't poll too often — the server caches for 60 seconds

The Trafiklab server caches departure data server-side for **~60 seconds**. Polling faster than once per minute fetches the exact same data and burns your API quota for no gain. The default 5-minute interval is the right balance for most commute scenarios.

### Multiple boards multiply your API calls

Each board makes its own API call on every poll. If you have five boards set to 1-minute polling, that's 300 calls per hour. The free default quota is generous enough for personal use at sensible intervals, but it's easy to hit limits if you overdo it.

> **Rule of thumb:** Keep the polling interval at **3 minutes or above** per board. Use the **Monitoring** toggle in a flow to pause boards outside the hours you actually care about — for example, switch off the commute board at night.

Approximate daily API usage at the default 5-minute interval:

| Boards | Requests/day | Requests/month |
|---|---|---|
| 1 | ~288 | ~8 600 |
| 3 | ~864 | ~26 000 |
| 5 | ~1 440 | ~43 200 |
| 10 | ~2 880 | ~86 400 |

### The minute countdown only refreshes on each poll

The *Departs in* counter updates when new data is fetched, not every second. Between polls it holds its last value. If you need a precise countdown for an automation, trigger a **Refresh departure data** action just before you read it.

### Filters stack — start broad and narrow down

Transport type, line filter and destination filter all apply together (AND logic). If you set type = *Bus* and line = `14`, you only see bus line 14. Start with no filters, confirm you're seeing data, then add filters one at a time.

### Arrivals mode shows where the vehicle is coming *from*

When **Show** is set to *Arrivals*, the *Destination* tile and `destination` token show the vehicle's **origin** — not where it's going. This matches how physical arrival boards work at stations.

### Cancelled departures show up — they're not hidden

Cancelled departures appear in the board rather than being silently skipped. The *Destination* tile shows *CANCELLED* and the `is_cancelled` token is `true`. This is intentional — the **A departure has been cancelled** trigger card lets you act on it rather than silently miss a departure.

### API key errors

If the *Status* capability shows *Forbidden* or *Invalid key*, your API key is either wrong or has been regenerated in the Trafiklab portal. Go to **Settings → Apps → Swedish Public Transport**, paste the correct key and save.

---

## Data source

Departure and arrival data is provided by [Trafiklab.se](https://www.trafiklab.se) under the [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) licence. Coverage includes all Swedish public transport operators. Real-time data availability varies by region and operator.
