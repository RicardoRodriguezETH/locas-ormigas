# Locas Ormigas

An ant colony simulation, originally a [Löve2D/Lua project](https://www.youtube.com/watch?v=G5wb4f5n6qQ)
and now being modernized as a browser-based TypeScript + PixiJS rewrite.

## 🐜 [Play the current build](https://ricardorodriguezeth.github.io/locas-ormigas/)

Runs entirely in the browser — no install needed. Auto-deployed from [`web/`](web/) on every push.

## What's here

- **[`web/`](web/)** — the active project: a from-scratch TypeScript + PixiJS rewrite that's
  grown well past a 1:1 port. A colony of ants forages between a cave and food sources, tended
  by a queen and brood, digs an underground chamber network, and finds its way home using one of
  four selectable pheromone-trail algorithms. See [`web/README.md`](web/README.md) for
  architecture, scripts, and current feature status.
- **[`main.lua`](main.lua) and friends** — the original Löve2D/Lua version. Kept for reference;
  not under active development. See below for how to run it.

## Running the original Lua version

- Install [Löve2D](https://love2d.org/).
- Download the `.love` file from the [latest release](https://github.com/piXelicidio/locas-ants/releases/latest)
  and double-click it, **or** clone this repo and open it with [ZeroBrane Studio](https://studio.zerobrane.com/download)
  (`Project → Lua Interpreter → LÖVE`, then `F6` to run).

![](https://raw.githubusercontent.com/piXelicidio/locas-ants/develop/screenshots/nicePath.gif)

[Follow me on Twitter](https://twitter.com/DenysAlmaral)
