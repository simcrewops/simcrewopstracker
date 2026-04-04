# SimCrewOps Tracker

Desktop app for Microsoft Flight Simulator 2020 / 2024 that connects via SimConnect and automatically logs your flights to [simcrewops.com](https://simcrewops.com).

## Features

- Connects to MSFS via SimConnect (Windows only)
- Tracks flight phases: taxi, takeoff, climb, cruise, descent, approach, landing
- Records air time, block time, landing rate, G-force, max altitude, fuel used
- Detects departure and arrival airports (ICAO)
- Touchdown zone detection (first 1000–1500 ft past threshold)
- Auto-submits completed flights to your SimCrewOps logbook
- Runs in the system tray, minimizes on close

## Download

Download the latest Windows installer from the [Releases](../../releases/latest) page.

## Setup

1. Install the app from the `.exe` installer
2. Open SimCrewOps Tracker
3. Go to **Settings** and paste your Tracker API Key (find it at simcrewops.com → Sim Tracker → API Key)
4. Start Microsoft Flight Simulator
5. The tracker will auto-connect and begin logging

## Requirements

- Windows 10/11 (64-bit)
- Microsoft Flight Simulator 2020 or 2024
- SimConnect (included with MSFS)
- A [simcrewops.com](https://simcrewops.com) account with Sim Tracker enabled
