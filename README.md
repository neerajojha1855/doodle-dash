# Doodle Dash

Doodle Dash is a fast-paced, real-time multiplayer drawing and guessing party game. Grab a phone or laptop, join a room with your friends, and see drawings appear live on your screen. The fastest guessers win the most points.

---

## Features

- Real-Time Multiplayer: Built with Server-Sent Events (SSE) for low-latency synchronization of strokes and game state across 2 to 8 players.
- Advanced Drawing Tools:
  - Dynamic Brushes: Choose between Normal, Spray (airbrush), and Marker (highlighter) styles.
  - Color Picker: Select custom colors for your drawing.
  - Undo & Clear: Easily remove your last stroke or wipe the canvas clean.
  - Adjustable Sizes: Slider for precise brush and eraser thickness.
- Live Guessing Engine: Real-time guess feed. If you guess the secret word correctly, your guess is hidden from others, and you earn points based on how fast you answered.
- Responsive & Modern UI: Built with a clean aesthetic and custom SVG branding, optimized for both desktop and mobile devices.

---

## Getting Started

### Prerequisites
- Node.js (v16 or higher recommended)

### Installation

1. Clone the repository (or download the source code):
   ```bash
   git clone https://github.com/neerajojha1855/doodle-dash.git
   cd doodle-dash
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Play: 
   Open your browser and navigate to `http://localhost:3000`. 
   To play with friends on the same Wi-Fi network, share your local IP address shown in the terminal (e.g., `http://192.168.1.x:3000`).

---

## How to Play

1. Create a Room: Enter your name and click "Create room". You will receive a 5-character invite code.
2. Invite Friends: Share the code. Other players can join from their own devices by entering it on the home screen.
3. The Rules:
   - The game consists of 5 rounds, with 60 seconds per drawing.
   - When it is your turn, you will receive a secret word. Draw it using the provided toolset.
   - When it is not your turn, type your guesses into the chat. 
   - Correct guesses earn up to 150 points depending on speed. The drawer also earns a 100-point bonus when someone finds the word.
4. Winning: The player with the highest total score at the end of round 5 wins the game.

---

## Tech Stack

- Frontend: Vanilla HTML5, CSS3, and JavaScript.
- Backend: Node.js
- Network: HTTP Server-Sent Events (SSE) for state broadcasting, fetch API for client actions.
- Icons: Remixicon

---

## Author

Made by Neeraj Ojha
- LinkedIn: https://linkedin.com/in/neerajojha1855
- GitHub: https://github.com/neerajojha1855
- Portfolio: https://neeraj-ojha.replit.app
