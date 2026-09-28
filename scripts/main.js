import { world, system, Player } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

// ---------------------------------------------------------------------------
// Far Lands Expedition Stabilizer v1.2
// Heart of the Sea = control panel item (creative inventory)
// Read-mostly safety net. No terrain replacement. Manual platform only.
// ---------------------------------------------------------------------------

const ITEM_ID = "minecraft:heart_of_the_sea";

const CFG = {
  monitorInterval: 5,
  hudInterval: 10,
  stableSamplesRequired: 12,
  suspiciousTicks: 20,
  confirmTicks: 40,
  postTeleportCooldown: 40,
  yStableEpsilon: 0.15,
  fallVelocityThreshold: -0.4,
  extremeDist: 4_000_000,
  debugDefault: false
};

const Mode = {
  NORMAL: "NORMAL",
  SUSPICIOUS: "SUSPICIOUS",
  TERRAIN_LOSS: "TERRAIN_LOSS",
  RECOVERY: "RECOVERY"
};

/** @type {Map<string, any>} */
const states = new Map();

function getState(player) {
  const id = player.id;
  if (states.has(id)) return states.get(id);

  let lastSafe = { x: player.location.x, y: player.location.y, z: player.location.z };
  try {
    const sx = player.getDynamicProperty("farlands:lastSafeX");
    const sy = player.getDynamicProperty("farlands:lastSafeY");
    const sz = player.getDynamicProperty("farlands:lastSafeZ");
    if (typeof sx === "number" && typeof sy === "number" && typeof sz === "number") {
      lastSafe = { x: sx, y: sy, z: sz };
    }
  } catch (_) {}

  const s = {
    mode: Mode.NORMAL,
    lastSafe,
    candidate: null,
    candidateGood: 0,
    suspiciousCount: 0,
    confirmCount: 0,
    lastTeleportTick: -9999,
    enabled: true,
    hud: true,
    debug: CFG.debugDefault,
    lastHudTick: 0,
    yHistory: []
  };
  states.set(id, s);
  return s;
}

function saveLastSafe(player, pos) {
  try {
    player.setDynamicProperty("farlands:lastSafeX", pos.x);
    player.setDynamicProperty("farlands:lastSafeY", pos.y);
    player.setDynamicProperty("farlands:lastSafeZ", pos.z);
  } catch (e) {
    console.warn(`[Farlands] saveLastSafe failed: ${e}`);
  }
}

function safeGetBlock(dim, loc) {
  try {
    const b = dim.getBlock(loc);
    if (b === undefined) return { ok: false, reason: "undefined", typeId: null, isAir: true };
    const typeId = b.typeId;
    const isAir = b.isAir;
    return { ok: true, reason: "ok", typeId, isAir, block: b };
  } catch (e) {
    return { ok: false, reason: e.name || String(e), typeId: null, isAir: true };
  }
}

function distXZ(loc) {
  return Math.sqrt(loc.x * loc.x + loc.z * loc.z);
}

function sample(player, s) {
  const loc = player.location;
  const vel = player.getVelocity();
  const blockLoc = {
    x: Math.floor(loc.x),
    y: Math.floor(loc.y - 0.1),
    z: Math.floor(loc.z)
  };
  const below = safeGetBlock(player.dimension, blockLoc);

  s.yHistory.push(loc.y);
  if (s.yHistory.length > 8) s.yHistory.shift();
  const yMin = Math.min(...s.yHistory);
  const yMax = Math.max(...s.yHistory);
  const yStable = yMax - yMin <= CFG.yStableEpsilon;

  let intentionalFlight = false;
  try {
    intentionalFlight = player.isGliding || player.isFlying || vel.y > 0.3;
  } catch (_) {}

  let onGround = false;
  let falling = false;
  try {
    onGround = player.isOnGround;
    falling = player.isFalling;
  } catch (_) {}

  return {
    loc,
    vel,
    below,
    yStable,
    intentionalFlight,
    onGround,
    falling
  };
}

function maybeUpdateLastSafe(player, s, samp) {
  if (system.currentTick - s.lastTeleportTick < CFG.postTeleportCooldown) return;
  if (samp.intentionalFlight) return;
  if (!samp.below.ok || samp.below.isAir) {
    s.candidateGood = 0;
    s.candidate = null;
    return;
  }
  if (!samp.yStable || samp.vel.y < -0.1) {
    s.candidateGood = 0;
    return;
  }

  if (!s.candidate) {
    s.candidate = { x: samp.loc.x, y: samp.loc.y, z: samp.loc.z };
    s.candidateGood = 1;
  } else {
    const dx = samp.loc.x - s.candidate.x;
    const dz = samp.loc.z - s.candidate.z;
    if (dx * dx + dz * dz < 4) {
      s.candidateGood++;
    } else {
      s.candidate = { x: samp.loc.x, y: samp.loc.y, z: samp.loc.z };
      s.candidateGood = 1;
    }
  }

  if (s.candidateGood >= CFG.stableSamplesRequired) {
    s.lastSafe = { ...s.candidate };
    saveLastSafe(player, s.lastSafe);
    s.candidateGood = 0;
    if (s.debug) {
      console.warn(
        `[Farlands] lastSafe confirmed ${s.lastSafe.x.toFixed(2)} ${s.lastSafe.y.toFixed(2)} ${s.lastSafe.z.toFixed(2)}`
      );
    }
  }
}

function runStateMachine(player, s, samp) {
  if (!s.enabled) return;

  const hardFall =
    samp.vel.y < CFG.fallVelocityThreshold ||
    (s.yHistory.length >= 4 && samp.loc.y < s.yHistory[0] - 2);

  const blockBad = !samp.below.ok || samp.below.isAir;
  const evidence = hardFall && blockBad && !samp.intentionalFlight;

  switch (s.mode) {
    case Mode.NORMAL:
      if (evidence) {
        s.mode = Mode.SUSPICIOUS;
        s.suspiciousCount = 1;
        if (s.debug) console.warn("[Farlands] → SUSPICIOUS");
      } else {
        s.suspiciousCount = 0;
        maybeUpdateLastSafe(player, s, samp);
      }
      break;

    case Mode.SUSPICIOUS:
      if (!evidence) {
        s.mode = Mode.NORMAL;
        s.suspiciousCount = 0;
        break;
      }
      s.suspiciousCount++;
      if (s.suspiciousCount >= CFG.suspiciousTicks) {
        s.mode = Mode.TERRAIN_LOSS;
        s.confirmCount = 0;
        if (s.debug) console.warn("[Farlands] → TERRAIN_LOSS");
      }
      break;

    case Mode.TERRAIN_LOSS:
      if (!evidence) {
        s.mode = Mode.NORMAL;
        s.confirmCount = 0;
        break;
      }
      s.confirmCount++;
      if (s.confirmCount >= CFG.confirmTicks) {
        s.mode = Mode.RECOVERY;
      }
      break;

    case Mode.RECOVERY:
      try {
        player.teleport(s.lastSafe, { checkForBlocks: false, keepVelocity: false });
        s.lastTeleportTick = system.currentTick;
        player.sendMessage("§e[Farlands] Recovered to last confirmed safe position");
        if (s.debug) {
          console.warn(`[Farlands] RECOVERY → ${s.lastSafe.x} ${s.lastSafe.y} ${s.lastSafe.z}`);
        }
      } catch (e) {
        console.warn(`[Farlands] teleport failed: ${e}`);
        player.sendMessage("§c[Farlands] Recovery teleport failed – see content log");
      }
      s.mode = Mode.NORMAL;
      s.suspiciousCount = 0;
      s.confirmCount = 0;
      break;
  }
}

// ---------------------------------------------------------------------------
// Heart of the Sea UI
// ---------------------------------------------------------------------------
function showMainMenu(player) {
  const s = getState(player);
  const loc = player.location;
  const d = distXZ(loc);

  const form = new ActionFormData()
    .title("§3Far Lands Control")
    .body(
      `§7Mode: §f${s.mode}\n` +
        `§7Pos: §f${loc.x.toFixed(0)} ${loc.y.toFixed(1)} ${loc.z.toFixed(0)}\n` +
        `§7Distance: §f${(d / 1e6).toFixed(3)} M\n` +
        `§7Last safe: §f${s.lastSafe.x.toFixed(0)} ${s.lastSafe.y.toFixed(1)} ${s.lastSafe.z.toFixed(0)}\n` +
        `§7Stabilizer: §${s.enabled ? "aON" : "cOFF"} §7| HUD: §${s.hud ? "aON" : "cOFF"} §7| Debug: §${s.debug ? "aON" : "cOFF"}`
    )
    .button("§aStatus report")
    .button("§eReturn to last safe")
    .button("§6Force save current as last safe")
    .button(s.enabled ? "§cDisable stabilizer" : "§aEnable stabilizer")
    .button(s.hud ? "§7Hide HUD" : "§7Show HUD")
    .button(s.debug ? "§7Debug OFF" : "§7Debug ON")
    .button("§bRun diagnostic snapshot")
    .button("§6Manual rescue platform (5×5 barrier)")
    .button("§8Close");

  form.show(player).then((res) => {
    if (res.canceled || res.selection === undefined) return;
    switch (res.selection) {
      case 0:
        sendStatus(player);
        break;
      case 1:
        s.mode = Mode.RECOVERY;
        player.sendMessage("§e[Farlands] Manual recovery requested…");
        break;
      case 2:
        s.lastSafe = { x: player.location.x, y: player.location.y, z: player.location.z };
        saveLastSafe(player, s.lastSafe);
        s.candidate = null;
        s.candidateGood = 0;
        player.sendMessage("§a[Farlands] Current position saved as last safe");
        break;
      case 3:
        s.enabled = !s.enabled;
        player.sendMessage(`§e[Farlands] Stabilizer ${s.enabled ? "§aON" : "§cOFF"}`);
        break;
      case 4:
        s.hud = !s.hud;
        player.sendMessage(`§e[Farlands] HUD ${s.hud ? "§aON" : "§cOFF"}`);
        break;
      case 5:
        s.debug = !s.debug;
        player.sendMessage(`§e[Farlands] Debug ${s.debug ? "§aON" : "§cOFF"}`);
        break;
      case 6:
        runDiag(player);
        break;
      case 7:
        confirmPlatform(player);
        break;
      default:
        break;
    }
  });
}

function sendStatus(player) {
  const s = getState(player);
  const loc = player.location;
  const below = safeGetBlock(player.dimension, {
    x: Math.floor(loc.x),
    y: Math.floor(loc.y - 0.1),
    z: Math.floor(loc.z)
  });
  let onGround = "?";
  let falling = "?";
  try {
    onGround = String(player.isOnGround);
    falling = String(player.isFalling);
  } catch (_) {}
  player.sendMessage("§6=== Farlands Status ===");
  player.sendMessage(`§7Mode: §f${s.mode}`);
  player.sendMessage(`§7Pos (raw): §f${loc.x} ${loc.y} ${loc.z}`);
  player.sendMessage(
    `§7LastSafe: §f${s.lastSafe.x.toFixed(2)} ${s.lastSafe.y.toFixed(2)} ${s.lastSafe.z.toFixed(2)}`
  );
  player.sendMessage(`§7Block below: §f${below.ok ? below.typeId : below.reason}`);
  player.sendMessage(`§7isOnGround: §f${onGround}  isFalling: §f${falling}`);
  try {
    player.sendMessage(`§7Vel: §f${JSON.stringify(player.getVelocity())}`);
  } catch (_) {}
}

function runDiag(player) {
  const loc = player.location;
  const vel = player.getVelocity();
  const below = safeGetBlock(player.dimension, {
    x: Math.floor(loc.x),
    y: Math.floor(loc.y - 0.1),
    z: Math.floor(loc.z)
  });
  let onG = "?";
  let fall = "?";
  let glide = "?";
  try {
    onG = String(player.isOnGround);
    fall = String(player.isFalling);
    glide = String(player.isGliding);
  } catch (_) {}
  const msg = [
    `DIAG raw=${loc.x},${loc.y},${loc.z}`,
    `floor=${Math.floor(loc.x)},${Math.floor(loc.y)},${Math.floor(loc.z)}`,
    `vel=${vel.x.toFixed(3)},${vel.y.toFixed(3)},${vel.z.toFixed(3)}`,
    `onG=${onG} fall=${fall} glide=${glide}`,
    `below=${below.ok ? below.typeId : below.reason}`,
    `chunk=${Math.floor(loc.x / 16)},${Math.floor(loc.z / 16)}`
  ].join(" | ");
  console.warn(`[Farlands] ${msg}`);
  player.sendMessage(`§b[Diag] ${msg}`);
}

function confirmPlatform(player) {
  const form = new MessageFormData()
    .title("§6Manual rescue platform")
    .body(
      "Place a 5×5 barrier platform under your feet?\n\n" +
        "§cThis modifies blocks at your CURRENT location only.\n" +
        "§7Use only when you have lost collision and need a pad.\n" +
        "§8ARTIFICIAL — not world terrain."
    )
    .button1("§aPlace platform")
    .button2("§cCancel");

  form.show(player).then((res) => {
    if (res.canceled || res.selection !== 0) {
      player.sendMessage("§7[Farlands] Platform cancelled");
      return;
    }
    placePlatform(player);
  });
}

function placePlatform(player) {
  const loc = player.location;
  const y = Math.floor(loc.y) - 1;
  const cx = Math.floor(loc.x);
  const cz = Math.floor(loc.z);
  let n = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const res = safeGetBlock(player.dimension, { x: cx + dx, y, z: cz + dz });
      if (!res.ok || !res.block) continue;
      try {
        res.block.setType("minecraft:barrier");
        n++;
      } catch (_) {}
    }
  }
  player.sendMessage(`§6[Farlands] Manual platform: ${n} barriers (ARTIFICIAL)`);
}

// Use Heart of the Sea to open UI
world.afterEvents.itemUse.subscribe((ev) => {
  try {
    if (!ev.itemStack || ev.itemStack.typeId !== ITEM_ID) return;
    const player = ev.source;
    if (!(player instanceof Player)) return;
    system.run(() => showMainMenu(player));
  } catch (e) {
    console.warn(`[Farlands] itemUse handler: ${e}`);
  }
});

// ---------------------------------------------------------------------------
// Monitor loop
// ---------------------------------------------------------------------------
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const s = getState(player);
    const samp = sample(player, s);
    runStateMachine(player, s, samp);

    if (s.hud && system.currentTick - s.lastHudTick >= CFG.hudInterval) {
      s.lastHudTick = system.currentTick;
      const d = distXZ(samp.loc);
      const line =
        `§7${samp.loc.x.toFixed(0)} ${samp.loc.y.toFixed(1)} ${samp.loc.z.toFixed(0)} ` +
        `§8| §7D:${(d / 1e6).toFixed(2)}M §8| §7${s.mode} ` +
        `§8| §7Blk:${samp.below.ok ? "§aY" : "§cN"} ` +
        `§7G:${samp.onGround ? "§aY" : "§cN"}`;
      try {
        player.onScreenDisplay.setActionBar(line);
      } catch (_) {}
    }
  }
}, CFG.monitorInterval);

// Script events still work as backup
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (!ev.id.startsWith("farlands:")) return;
  const player = ev.sourceEntity;
  if (!(player instanceof Player)) return;
  const s = getState(player);

  switch (ev.id) {
    case "farlands:menu":
      showMainMenu(player);
      break;
    case "farlands:status":
      sendStatus(player);
      break;
    case "farlands:return":
      s.mode = Mode.RECOVERY;
      break;
    case "farlands:toggle":
      s.enabled = !s.enabled;
      player.sendMessage(`§e[Farlands] Stabilizer ${s.enabled ? "§aON" : "§cOFF"}`);
      break;
    case "farlands:hud":
      s.hud = !s.hud;
      player.sendMessage(`§e[Farlands] HUD ${s.hud ? "§aON" : "§cOFF"}`);
      break;
    case "farlands:debug":
      s.debug = !s.debug;
      player.sendMessage(`§e[Farlands] Debug ${s.debug ? "§aON" : "§cOFF"}`);
      break;
    case "farlands:setsafe":
      s.lastSafe = { x: player.location.x, y: player.location.y, z: player.location.z };
      saveLastSafe(player, s.lastSafe);
      s.candidate = null;
      s.candidateGood = 0;
      player.sendMessage("§a[Farlands] Forced current position as lastSafe");
      break;
    case "farlands:platform":
      confirmPlatform(player);
      break;
    case "farlands:diag":
      runDiag(player);
      break;
  }
});

world.afterEvents.playerLeave.subscribe((ev) => {
  states.delete(ev.playerId);
});

console.warn("[Farlands Expedition Stabilizer] v1.2 — use Heart of the Sea to open control panel");
