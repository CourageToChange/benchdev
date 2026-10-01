# BenchDev: User Guide

Last updated: 2026-10-01.

BenchDev answers one question: **how fast is this device?** You open a page, press a button, and
about half a minute later you get a single number with all of the working shown underneath it.

## Getting in

Open the page in a browser. There is nothing to install and no account to make.

It needs a browser with WebGL2, which is nearly all of them. If yours does not have it, the run
stops partway with no score, and the reason is in the diagnostic JSON. It will not quietly hand you
a lower score.

## The basics

1. **Choose how long you want it to take.** Two options sit near the top:
   - **Quick**, about 25 seconds. Measures the processor and the graphics.
   - **Full**, about 73 seconds. Everything Quick does, plus 40 seconds of sustained load to see
     whether your device slows down during extended work.
2. **Press "Run device benchmark".**
3. **Read what it is about to do, then press the button that names the action** ("Start the
   25-second test"). It tells you plainly that your device will be busy and may feel slower.
4. **Leave the tab in front and wait.** Ordinary things may feel sluggish while it runs. That is the
   point.
5. **Read your score.**

## While it is running

You will see the phase it is on, a short line explaining what that phase measures, a progress bar
and the time elapsed.

**You will not see any numbers changing.** That is deliberate. A number that moves while the test is
still running is a number somebody screenshots, and it would not mean anything yet.

**To stop it:** press **Cancel**, or just press **Escape**. It stops immediately with no "are you
sure" question, because the only thing you lose is the time you have already waited. Nothing is
saved from a cancelled run.

## Your result

**The score** sits on a line with one labelled mark on it. That mark is a real, named device, with
the month it was measured, so you always know what the number is being compared against. It is not a
percentile and it is not "better than 60% of devices", because BenchDev has no idea what other
people's devices do.

**The sub-scores** show the four things it measured separately:

| Sub-score | What it means |
|---|---|
| CPU JavaScript single thread | Ordinary single-threaded work, the kind most web pages do |
| CPU WASM single thread | The integer half of the JavaScript test, compiled to WebAssembly. Its units are smaller than the JavaScript test's, so its raw number is not a like-for-like comparison with that row |
| CPU parallel | How much your processor gets done on 1, 2, 4 and 8 threads at once, keeping the best. It never tries more than 8 |
| GPU | Sustained graphics work at a fixed scene size |

**The composition is part of the score.** If one part could not be measured, the score says so next
to itself.

**The named device comparison** sits in a table below your result. Your current run is always the
first row. Every other row comes from the static BenchDev corpus and uses the same benchmark
protocol and the same scoring version as your run. A result measured under a different
protocol, or one scored with different weights, never appears in the same table.

A **claimed label** is a device name supplied by a person. **Detected details** are facts the browser
reported, such as its name, the graphics renderer and measured parallelism. They appear in separate
columns because a browser cannot reliably identify a device model. If no measured comparison rows
exist for the current protocol, the page says **"No comparison devices yet."**

**Raw values and diagnostic JSON** sit at the bottom. "Copy diagnostic JSON" puts the full details on
your clipboard, which is the thing to paste if you ever want to compare two runs properly.

### On a Full run: the sustained section

After the long load, you get one of three verdicts:

- **Held steady:** it finished as fast as it started.
- **No measurable change:** the difference was smaller than the wobble the test measured in its own
  first five seconds (or 1%, if that is bigger). Too small to call.
- **Slowed under load:** it genuinely did less work at the end than at the beginning.

Then a **recovery** line. After the load, BenchDev rests for five seconds and runs the first
processor test again for three seconds. If it gets back to at least 90% of its earlier speed, that
counts as recovered. If it does not, the cause is marked **unattributed**. It does not guess.

**BenchDev does not report hardware sensor readings.** Browsers do not expose them. It reports the
thing it can actually observe, which is whether performance falls off and whether it comes back.

## When there is no score

Sometimes you get **"No score was produced"** instead of a number. This is not an error and nothing
has gone wrong with your device. It means the conditions during the run were not good enough to
stand behind a number, so BenchDev would rather give you nothing than give you something wrong.

Each reason comes with what happened and what to do. The common ones:

- **The measured window was interrupted:** the tab was not in front the whole time. Browsers slow
  down background tabs heavily, so the result would have measured that browser restriction, not your
  device. Bring the tab forward and run it again.
- **Display timing changed:** something changed your screen's refresh rate mid-run, often a laptop
  being unplugged or a battery saver switching on. Plug in, then run it again.
- **Hardware graphics were unavailable:** the browser fell back to software rendering, so the
  graphics number would describe a driver, not a graphics card.
- **The timer could not resolve the work:** the browser's clock was too coarse to time the work
  reliably, which some privacy settings cause.

## Tips

- **Run it more than once.** Three runs tell you far more than one, and a well-behaved device should
  land within a few points each time.
- **Close heavy things first.** A video call or a game in another window will show up in the number.
- **Power state can change performance.** If you want to know what the machine can do while plugged
  in, connect its power supply before the run.
- **The score belongs to the browser as much as the device.** Browsers run the same code on
  different engines, so the result records which one you used.

## Trouble?

**The button does nothing.** Check the browser is not blocking JavaScript for the page.

**It says hardware graphics were unavailable, but I have a graphics card.** Some browsers disable
hardware acceleration by default, or turn it off on battery. Look for "use hardware acceleration when
available" in the browser's settings.

**My score changed between runs.** A few points is normal. A large change usually means something
else was running, or the previous run was still affecting the device. Pause briefly before retrying.

**I want to compare two devices.** Run the same length on both, in the same browser, and compare the
sub-scores as well as the total. A device can win on one and lose badly on another, which the single
number deliberately hides.
