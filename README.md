# Far Lands Expedition Stabilizer

**Minecraft Bedrock 1.26.51** · Safety net + diagnostic instrument for *real* extreme-coordinate exploration.

> This does **not** recreate the Far Lands, replace terrain, or fix engine float precision.  
> It tracks a conservative last-safe position, detects sustained terrain-loss symptoms, recovers you by teleport, and logs diagnostics.

## Control item: Heart of the Sea

1. Creative inventory → **Heart of the Sea** (`minecraft:heart_of_the_sea`)
2. Hold it and **use** (right-click / long-press)
3. Control panel opens

### Menu actions

| Button | Effect |
|--------|--------|
| Status report | Chat dump of position, last safe, block below, velocity |
| Return to last safe | Manual recovery teleport |
| Force save current as last safe | Overrides confirmed last-safe |
| Enable / Disable stabilizer | Turns automatic recovery on/off |
| Show / Hide HUD | Action-bar monitor |
| Debug ON / OFF | Content-log detail |
| Run diagnostic snapshot | One-line engine measurement |
| Manual rescue platform | Confirm → 5×5 barrier under feet (only when you ask) |

### Optional chat commands

```
/scriptevent farlands:menu
/scriptevent farlands:status
/scriptevent farlands:return
/scriptevent farlands:toggle
/scriptevent farlands:hud
/scriptevent farlands:debug
/scriptevent farlands:setsafe
/scriptevent farlands:platform
/scriptevent farlands:diag
```

## Install (iPhone / existing world)

1. Zip the pack folder so `manifest.json` is at the zip root.
2. Import as a behavior pack.
3. Edit world → Behavior packs → activate.
4. No Beta APIs experiment required (`@minecraft/server` 2.9.0 + `@minecraft/server-ui` 2.0.0 stable).

**Test on a world copy first.**

## What it will / will not do

**Will**

- Persist last confirmed safe X/Y/Z (dynamic properties)
- Multi-sample Y stability + velocity + block-query evidence before recovery
- State machine: NORMAL → SUSPICIOUS → TERRAIN_LOSS → RECOVERY
- Lightweight HUD
- Heart of the Sea UI + scriptevents
- Manual barrier platform only after confirmation

**Will not**

- Replace or regenerate terrain
- Create dimensions or fake Far Lands
- Auto-place blocks on recovery
- Trust `isOnGround` alone at extreme coords

## Engine limits (explicit)

Past ~±8 388 608, 32-bit float precision collapses entity hitboxes. Script API **cannot** restore real collision. Best effort = detect uncontrolled fall + bad block reads, then teleport to last confirmed good position.

## Diagnostic ladder

At each of: 1M, 2M, 4M, 6M, 8M, 8.3M, 8.388608M, 9M, 10M, 11M, 12M, 14M, 16M, 18M, 20M:

1. Open Heart of the Sea → **Run diagnostic snapshot**
2. Walk ±1 block; note quantization
3. Jump once; confirm no false recovery
4. Record results — do not assume outcomes

## Pack structure

```
farlands_expedition_stabilizer/
├── manifest.json
├── README.md
├── LEARNINGS.md
└── scripts/
    └── main.js
```

## Rollback

Deactivate the behavior pack. Only persistent data: player dynamic properties `farlands:lastSafeX/Y/Z`. Optional barriers can be broken by hand.

---

Packwright Smith · Bedrock extreme-coordinate expedition tooling
