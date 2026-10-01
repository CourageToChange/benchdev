# BenchDev

How fast is this device? BenchDev answers that from a web page. You press one button, wait about
25 seconds, and get one score for the processor and the graphics, with the working shown underneath.

I wanted something like fast.com, but for testing a device instead of an internet connection. Clean
to look at, quick to run, and a benchmark I could actually trust. The last part turned out to be most
of the work.

[How to use it](USER-GUIDE.md)

## What it measures

A **Quick** run takes about 25 seconds and runs four tests: single-threaded JavaScript, the same
JavaScript on 1, 2, 4 and then 8 threads (it keeps whichever got the most done), a WebAssembly
version of the integer part of the single-threaded test, and a graphics test that renders a scene
as fast as the card allows.

On my desktop the browser reports 16 threads and the test stops at 8, so it never finds out what the
other 8 would add.

A **Full** run takes about 73 seconds. It does everything Quick does, then keeps the graphics card
busy for 40 seconds to see whether the device slows down under sustained load. After that it rests
for five seconds and runs the first processor test again for three, to see whether it has got its
speed back.

The score is scaled so that 100 is one named reference device: my desktop, a Ryzen 7 5800X3D with a
Radeon RX 9070 XT. Its raw measurements are in this repo.

## What it deliberately does not do

**No temperature.** No browser exposes one, and I did not want to guess. What a browser can see is
a drop in speed, so that is what it reports: one plain sentence comparing how much graphics work got
done in the last five seconds with the first five, plus whether the processor got its speed back
after a rest. A slowdown can have more than one cause, so it does not claim to know which.

**No "faster than 80% of devices" either.** People who run benchmarks are not a fair sample of
everyone's devices, so a percentage like that would be made up however many results it had. It
compares your score with named devices instead. Right now that list has one entry, my desktop.

**A device name is only ever a claim.** A browser often cannot tell what it is running on. Safari
reports every Apple GPU as "Apple GPU", so an old iPhone and a new one look the same, and macOS
still says Intel in the user agent on an M-series Mac. So BenchDev does not ask what your device
is, and in the comparison table a name somebody typed sits in its own column, apart from what the
browser detected. Right now the only typed name in there is my desktop's.

Browsers run JavaScript and WebGL on different engines, so the same device will not score the same
in all of them. That is why the browser and its version are shown next to the score.

## Privacy

The page loads its own files and a small list of reference results. That is all it fetches. There is
no account, no cookie, no analytics and no identifier, and it does not save or upload your result.
If you want to keep one, there is a button to copy it as JSON.

The server that hosts it keeps no request log. Cloudflare carries the traffic and handles IP
addresses under its own privacy policy.

## Running it yourself

There is no build step. It is a static site, so serve the folder with any static file server (the
browser will not run its modules from a `file://` address) and open it.

`npm test` runs the unit tests. They need Node 24 or newer.

## Licence

The code is MIT. The two fonts, Anybody and Martian Mono, are under the SIL Open Font License, which
is in `assets/fonts/OFL.txt`.

Built with AI assistance.
