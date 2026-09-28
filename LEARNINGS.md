# Learnings — Bedrock 1.26.51 extreme coordinates (Packwright Smith)

## Root cause (confirmed)

Bedrock uses **32-bit floats** for entity position / hitbox corners / much of collision.

- Between 2^n and 2^{n+1}, position step ≈ 2^{n-23}
- **±8 388 608 (2^23)**: entity coords become integers; player-sized hitboxes sit on edges → systematic fall-through for the player
- **±16 777 216 (2^24)**: Stripe Lands (render collapse)
- Script receives JS doubles, but values are already quantized by the engine

## What Script API can do

| Capability | Reliable? |
|------------|-----------|
| Read player.location, velocity | Yes (quantized) |
| getBlock loaded vs error | Mostly (unloaded / OOB throw or undefined) |
| Distinguish air vs solid typeId | When chunk is loaded |
| Detect symptoms of fall-through | Partial (Y drop + velocity + bad below-block) |
| Restore real collision | **No — engine limit** |
| Trust isOnGround alone past 8M | **No — documented unexpected behaviour** |

## Design decisions locked in

1. **Conservative lastSafe** — multi-sample Y stability, readable non-air below, no post-teleport save, never save while falling.
2. **State machine** — NORMAL → SUSPICIOUS → TERRAIN_LOSS → RECOVERY; intentional glide/fly excluded.
3. **No auto platform** — only manual confirm via Heart of the Sea menu.
4. **UI item** — vanilla minecraft:heart_of_the_sea via world.afterEvents.itemUse + ActionFormData.
5. **Stable modules** — @minecraft/server 2.9.0, @minecraft/server-ui 2.0.0 (no beta experiment).

## APIs verified for this pack

- player.location, getVelocity, teleport / TeleportOptions.checkForBlocks
- isOnGround, isFalling, isGliding, isFlying (supporting only)
- Dimension.getBlock, Block.isAir, Block.typeId, Block.setType
- Dynamic properties on player
- system.runInterval, system.currentTick, system.afterEvents.scriptEventReceive
- world.afterEvents.itemUse, world.afterEvents.playerLeave
- player.onScreenDisplay.setActionBar
- ActionFormData, MessageFormData from @minecraft/server-ui

## Open measurements (user must run)

At 8M / 12M / 16M / 20M record:

- requested vs actual location deltas
- whether getBlock still returns solid typeIds when collision is gone
- whether movement quantizes to 1- or 2-block steps
- false-positive rate of SUSPICIOUS / RECOVERY during intentional jumps

## World safety

Writes limited to: dynamic properties, recovery teleport, optional confirmed barrier platform. No generation, dimension, or mass chunk mutation.
