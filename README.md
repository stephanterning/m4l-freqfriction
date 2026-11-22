# FreqFriction

A multitrack spectral masking monitor for Ableton Live. Select sources and a protected track to see where their frequency content overlaps. The optional FreqFriction Input helper adds another 31 stereo inputs.

![Frequency curves and highlighted regions in the FreqFriction monitor](docs/preview.png)

## Low-frequency masking warnings

FreqFriction compares the protected track with each selected input. In the bass range, two additional measurements centered at 65 and 130 Hz track how energy rises and falls on each track. A bass warning becomes weaker when the two low notes take turns, even if their upper harmonics coincide. The detector also tracks the recent peak of the protected track in each bass band. Its reference falls by 48 dB per second. When the band is more than 3 dB below that reference, a warning gradually loses weight. This can also reduce a warning for a quiet new note immediately after a loud one. The adjustment tapers to zero at 260 Hz.

Frequency-selective masking has been measured near 63 Hz, and temporal-window experiments show that timing matters for masking. The two measurement frequencies, window lengths and warning weights in FreqFriction are engineering choices. Their perceptual accuracy in a particular mix needs listening tests. [Jurado and Moore (2010)](https://pubmed.ncbi.nlm.nih.gov/21218891/) and [Plack and Moore (1990)](https://pubmed.ncbi.nlm.nih.gov/2348022/).

Run `python3 src/build.py` followed by `node tests/band-overlap.cjs` to compare the packaged detector with the previous scoring function using synthetic signals.
