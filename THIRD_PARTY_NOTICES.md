# Open-source acknowledgements

ServerLink uses Electron, xterm.js, node-pty and @electerm/ssh2. Dependency versions are locked in package-lock.json; their original licenses are included in the installed packages.

The app-owned known_hosts implementation and loopback SFTP fixture were developed with reference to Electerm's SSH/SFTP implementations:

- Electerm: https://github.com/electerm/electerm — MIT License.
- ssh2 / @electerm/ssh2: https://github.com/mscdex/ssh2 — MIT License.

The following notice applies to the referenced upstream material, not as a new license grant for all ServerLink code.

Copyright (c) since 2017~ ZHAO Xudong <zxdong@gmail.com>

Copyright Brian White. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
