# Kaun Sus Hai?

Kaun Sus Hai? is a spaceship party game for 3–12 players. Everyone gets a question, but one player secretly gets a different one. Once the answers are public, compare the receipts, hear each other's defences, and vote for the imposter. The game includes 90 question pairs across nine packs, with an illustrated command deck and an original synth soundtrack.

## Screenshots and gameplay

*Screenshot placeholder for the command deck and player lobby.*

*Gameplay clip placeholder for the Hot Seat, voting, and imposter reveal.*

## Run locally

### Online room or mixed group

Use Node.js 24 and npm. There is no build step.

```sh
npm ci
npm start
```

The server prints a JSON object with a port and separate `host` and `guest` tokens. On the host machine, open `http://127.0.0.1:43186/#host=YOUR_HOST_TOKEN`. Use **Invite Player** to copy the guest link or show its QR code. Keep the host link private and share only the guest link.

The server listens on loopback by default. For players on other devices, serve it through an HTTPS tunnel or reverse proxy, then open the host page on that HTTPS address before sharing invites. The invite uses the address in the host's browser. Use HTTPS for microphone access from other devices. The room runs in memory, so restarting the server normally resets it.

### Offline, on one device

Open [index.html](index.html) directly in a browser. Add your players and pass the device around for questions and ballots. This mode needs no npm install or server.

## How to play

1. Add players on the host device or invite them to join on their own phones. Pick question packs or keep **Full Chaos** for a mix.
2. Open your private question and enter a 1–5 word answer. One randomly selected player receives the alternate question.
3. When answers are in, the host opens **The receipts**. Tap an answer to open the Hot Seat. In the online room, repeatedly tap another player's name to send private emoji nudges. Players on their own devices can reply with text or a voice note.
4. Pick one other player and select **Lock In Vote**. The online room has a shared chat and discussion timeline. Ballot choices become visible after every player votes.
5. Reveal the result. If the imposter alone gets the most votes, everyone else gets 1 point. Otherwise, the imposter gets 2 points. The scoreboard carries totals into the next round.

Use the moon or sun button to switch themes and **♪** to toggle game audio. Nudge vibration depends on the receiving device and browser.

## Tech stack

- Vanilla HTML, CSS, and JavaScript, with no game engine, frontend framework, or bundler.
- Node.js built-in HTTP server for the online room and multiplayer state.
- `qrcode-generator` for invites, Web Audio for sound effects, and browser media APIs for voice notes.
- WebP artwork and AAC background music in [assets](assets/).

## Contributing

Clone the repository, create a branch from `main`, and test your changes in the browser.

```sh
git clone https://github.com/VSSOO7/game.git
cd game
git switch -c feature/your-change
npm ci
npm start
```

Commit and push your branch, then open a pull request against `main`. Describe what changed and how you tested it. If you don't have write access, fork the repository and open your pull request from the fork.
