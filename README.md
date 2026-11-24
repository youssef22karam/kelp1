# Day 17: Kelp

<img src="../videos/17-kelp.gif" alt="Kelp" width="384">

[Try it live](https://adamwebsite.com/codevember/17-kelp/)

A kelp forest under a moving surface: giant kelp to the top, sugar kelp on the rocks, sargassum adrift overhead, and fish from sardines to sharks. Sweep through it and the water moves.

## How to play

Sweep the pointer through the kelp to stir the water. Tap to send a surge. Press and hold on a kelp to pull it about, and turn the dial to move the sun.

Run it locally with `npm run dev` from the repo root, then open <http://localhost:3000/17-kelp/>.

## Technical overview

### The kelp

- Seven giant kelp, four detailed near the start and three coarse in the haze, with forking haptera, stipes, floats and blades.
- Each stipe is a CPU point chain driven by water drag and float lift, held to length from the root so it never stretches.
- Blades bend on the GPU to stream with the flow; press and hold drags a stipe toward the pointer along its chain.

### The water and light

- Swell sways the water less with depth over a steady current; pointer sweeps push the water and taps send surges.
- Caustics are traced up to the moving surface toward the sun, and soft light shafts swing round with the sun dial.
- The sky shows through Snell's window, bent by each wave's slope; outside it the surface mirrors the lit water below.
- Water darkens away from the sun; plankton at the lens blur into bokeh, and marine snow rises glinting through the shafts.

### Life

- Pacific rock crabs walk sideways in an alternating tetrapod, each segmented leg solved per frame as hinges in one plane.
- Fish tail beats come from CPU speed fed to the GPU as phase and strength; schools steer round the kelp, not through it.

### The floor

- Scanned sand on a mesh finest near the eye, with scanned reef rocks, thousands of pebbles and surfgrass bending in the swell.
- Bubble positions are computed from time on the GPU with nothing sent per frame, while silt and specks give the water depth.

Everyone whose work Codevember builds on is listed in [CREDITS.md](../CREDITS.md).
