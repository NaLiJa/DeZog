
import {MemBuffer} from "../../misc/membuffer";
import {UlaScreen} from "./ulascreen";
import {Z80Cpu} from "./z80cpu";


const logOn = false;	// TODO: REMOVE

/** Handles the ZX81 ULA screen.
 * Is derived from the Zx81UlaScreen which simulates the dfile.
 * The Zx81UlaScreenHiRes simulates/emulates the ZX81 ULA more correctly.
 * I.e. it generates the graphics from the data on the CPU bus.
 * Therefore it is capable of High Resolution graphics.
 * Drawback is that for development/debugging changes to the display/dfile
 * are not immediately visible, i.e. not before the vsync.
 *
 * There are 4 basic steps in generation of a screen display:
 * 1.  VSYNC, frame count and keyboard - NMI off
 * 2.  Blank lines/application code    - NMI on
 * 3.  VIDEO DISPLAY routine           - NMI off
 * 4.  Blank lines/application code    - NMI on
 *
 * For details of the zx81 ULA display see:
 * https://k1.spdns.de/Vintage/Sinclair/80/Sinclair%20ZX80/Tech%20specs/Wilf%20Rigter%27s%20ZX81%20Video%20Display%20Info.htm
 * https://8bit-museum.de/heimcomputer-2/sinclair/sinclair-scans/scans-zx81-video-display-system/
 * For details of the ULA HW and signals see:
 * https://oldcomputer.info/8bit/zx81/ULA/ula.htm
 * https://oldcomputer.info/8bit/zx81/ULA/ula.htm
 *
 */
export class Zx81UlaScreen extends UlaScreen {
	// Screen height
	public static SCREEN_HEIGHT = 192;

	// Screen width
	public static SCREEN_WIDTH = 256;

	// The previous state of the R-register.
	protected prevRregister = 0;

	// The state of the NMI generator
	protected stateNmiGeneratorOn = false;

	// The line 3-bit counter (0-7) to address the 8 lines of a character.
	protected ulaLineCounter = 0;

	// Counts lines independent of the ulaLineCounter. Is reset on a vsync.
	protected lineCounter = 0;

	// The tstates counter
	protected tstates = 0;

	// The number of tstates required for a horizontal scanline.
	protected TSTATES_PER_SCANLINE = 207;

	// The number of tstates for one full screen.
	protected TSTATES_PER_SCREEN = 65000;	// ~20ms

	// The HSYNC signal stay low for 16 tstates.
	protected TSTATES_OF_HSYNC_LOW = 16;

	// The minimal number of tstates for a VSYNC should be ~1ms => 3250 tstates.
	// But the generated vsync by the zx81 seems to be much smaller: 1233 tstates -> ~0.38ms
	// So the about the half is used for vsync recognition.
	protected VSYNC_MINIMAL_TSTATES = 500;

	// The tstates at which the VSYNC starts
	protected vsyncStartTstates = 0;

	// Used to generate the hsync
	protected hsyncTstatesCounter = 0;

	// Is set when an interrupt should be generated in the next cycle.
	protected int38InNextCycle = false;

	// The state of the HSYNC signal: on (low) or off (high).
	protected hsync = false;

	// The vsync signal
	protected vsync: boolean = false;

	// No display.
	protected noDisplay = false;

	// The original memory read function.
	protected memoryRead8: (addr64k: number) => number;

	// Chroma81-------------
	// The chroma mode: 0=Character code, 1=Attribute file:
	protected chroma81Mode = 0
	// Chroma81 enabled programattically:
	protected chroma81Enabled = false;


	/** Constructor.
	 * @param z80Cpu Mainly for the memoryModel and the ports.
	 * @param chroma81 True if the ZX81 Chroma81 support should be enabled.
	 * @param chroma81Init True if the Chroma81 memory should be initialized with a color.
	 */
	constructor(z80Cpu: Z80Cpu, chroma81: boolean, chroma81Init: boolean) {
		super(z80Cpu);

		// Register ULA ports
		z80Cpu.ports.registerGenericOutPortFunction(this.outPorts.bind(this));
		z80Cpu.ports.registerGenericInPortFunction(this.inPort.bind(this));

		// m1read8 (opcode fetch) is modified to emulate the ZX81 ULA.
		this.memoryRead8 = z80Cpu.memory.read8.bind(z80Cpu.memory);
		z80Cpu.memory.m1Read8 = this.ulaM1Read8.bind(this);

		// Chroma81 (Color support)
		if (chroma81) {
			// Register the Chroma81 ports
			z80Cpu.ports.registerSpecificOutPortFunction(0x7FEF, this.chroma81OutPort.bind(this));
			z80Cpu.ports.registerSpecificInPortFunction(0x7FEF, this.chroma81InPort.bind(this));
			// Init the color memory, otherwise it would be black on black.
			if (chroma81Init) {
				const attribColors = new Uint8Array(0x4000);	// Init all possible area
				attribColors.fill(0x26);	// yellow on red
				// for (let i = 0; i < 0x4000; i++)
				// 	attribColors[i] = i & 0xFF;
				z80Cpu.memory.writeBlock(0xC000, attribColors);
			}
		}
	}


	/** Resets the video buffer. */
	protected resetVideoBuffer() {
		// Override if needed
	}


	/** Handles the ULA out ports.
	 * 1. out (0xfd),a - turns NMI generator off
	 * 2. out (0xfe),a - turns NMI generator on
	 * (3. in a,(0xfe) - turns HSYNC generator off (if NMI is off))
	 * (4. out (0xff),a - turns VSYNC off)
	 * Note: the value of a is not ignored.
	 */
	protected outPorts(port: number, _data: number): void {
		// NMI generator off?
		if ((port & 0x0003) === 1) {
			// Usually 0xFD
			this.stateNmiGeneratorOn = false;
		}
		// NMI generator on?
		else if ((port & 0x0003) === 2) {
			// Usually 0xFE
			this.stateNmiGeneratorOn = true;
		}

		// Vsync?
		this.generateVsync(false);
	}


	/** Handles the ULA in port.
	 * 1. ...
	 * 2. ...
	 * 3. in a,(0xfe) - turns VSYNC on (if NMI is off)
	 * 4. ...
	 */
	protected inPort(port: number): number | undefined {
		// Check for address line A0 = LOW
		if ((port & 0x0001) === 0) {
			this.generateVsync(true);
		}
		return undefined;
	}


	/** Intercepts reading from the memory.
	 * For everything where A15 is set and data bit 6 is low, NOPs are returned.
	 * When data bit 6 is set it is expected to be the HALT instruction.
	 */
	protected ulaM1Read8(addr64k: number): number {
		// Read data from memory
		const data = this.memoryRead8(addr64k & 0x7FFF);

		// Check if it is character data and if bit 6 is low
		if ((addr64k & 0x8000) && (data & 0b01000000) === 0)
			return 0x00;	// NOP

		// Otherwise return the normal value
		return data;
	}


	/** Executes the ULA. The ZX81 ULA may grab tstates from
	 * the CPU to simulate the NMI interrupt.
	 * @param currentTstates The t-states that were just used by
	 * DMA or CPU.
	 */
	public execute(currentTstates: number) {
		this.tstates += currentTstates;

		// Execute int38 interrupt?
		if (this.int38InNextCycle) {
			this.int38InNextCycle = false;
			this.z80Cpu.interrupt(false, 0);
		}

		// Check for the R-register
		const r = this.z80Cpu.r;
		// Bit 6 changed from high to low
		if ((r & 0b0100_0000) === 0 && (this.prevRregister & 0b0100_0000) !== 0) {
			// -> interrupt in next cycle
			this.int38InNextCycle = true;
		}
		this.prevRregister = r;

		this.checkHsync(currentTstates);

		// No vsync/no display detection: no display if for 2*20 ms no Vsync was found
		if (this.tstates > this.vsyncStartTstates + 2 * this.TSTATES_PER_SCREEN) {
			if (!this.noDisplay) {
				// Change to no display
				this.noDisplay = true;
				this.emit('updateScreen');
			}
		}
	}


	/** Returns the dfile.
	 * @returns The screen as dfile (UInt8Array) plus the charset.
	 * If in FAST mode no display might be available. In this case only the charset is returned.
	 * { charset: Uint8Array, dfile: Uint8Array }
	 */
	public getUlaScreen(): any {
		// Read the charset 0x1E00-0x1FFF (512 bytes)
		const memory = this.z80Cpu.memory;
		const charset = memory.readBlock(0x1E00, 512);
		// Check for available VSYNC
		if (this.noDisplay)
			return {
				name: 'zx81',
				charset
			};
		// Get the content of the D_FILE system variable (2 bytes).
		const dfile_ptr = memory.getMemory16(0x400c);
		// 24 lines of 33 bytes (could be less).
		const dfile_maxlen = 33 * 24;
		const dfile = memory.readBlock(dfile_ptr, dfile_maxlen);

		// Color / Chroma 81
		let chroma;
		if (this.chroma81Enabled) {
			const mode = this.chroma81Mode;
			let data;
			if (mode === 0) {
				// Character code mode, mapping table at $C000-$C3FF
				data = memory.readBlock(0xC000, 0x0400);
			}
			else {
				// Attribute file mode, colors at DFILE+$8000
				const addr = (dfile_ptr + 0x8000) & 0xFFFF;
				data = memory.readBlock(addr, dfile_maxlen);
			}
			chroma = {
				mode,
				data
			};
		}

		return {
			name: 'zx81',
			dfile,
			charset,
			chroma
		};
	}


	/** Generate a VSYNC. Updates the display (emit).
	 * Is called by software: in-port -> vsync active, out-port -> vsync off
	 * @param on true to turn VSYNC on, false to turn it off.
	 * Note: The VSYNC is emitted only if the vsync active tiem (low)
	 * is long enough.
	 * Otherwise only the line counter is reset.
	 */
	protected generateVsync(on: boolean) {
		if (this.vsync == on)
			return;

		logOn && console.log(this.tstates, "generateVsync: " + (on ? "on (low)" : "off (high)"));

		// Vsync has changed
		if (on) {
			// VSYNC on (low)
			if (!this.stateNmiGeneratorOn) {
				logOn && console.log("  inPort A0=0: VSYNC?");
				logOn && console.log("  -> VSYNC on (low)");
				this.vsyncStartTstates = this.tstates;
				logOn && console.log(this.tstates, "  reset hsyncCounter");
				this.vsync = on;
			}
			return;
		}

		// VSYNC off (high)
		logOn && console.log(this.tstates, "vsync off:  !this.lineCounterEnabled == true");
		const lengthOfVsync = this.tstates - this.vsyncStartTstates;
		if (lengthOfVsync >= this.VSYNC_MINIMAL_TSTATES) {
			logOn && console.log(this.tstates, "  lengthOfVsync >= VSYNC_MINIMAL_TSTATES, lengthOfVsync=" + lengthOfVsync);

			// VSYNC
			//console.log('updateScreen', Date.now());
			this.noDisplay = false;
			this.lineCounter = 0;
			this.emit('updateScreen');
			this.resetVideoBuffer();
		}
		this.vsync = on;
		this.ulaLineCounter = 0;
		this.hsyncTstatesCounter = 0;  // Normal display would be one off if this was done in the VSYNC on (low) part.
	}


	/** Generate a HSYNC.
	 * Is called every instruction. Depending on tstates it generates the HSYNC.
	 * This is the High/Low switch ^^^^^^\_/^^^
	 * After ~191 tstates the HSYNC is low for 16 tstates. In total this is
	 * 207 tstates (=64us).
	 * On this switch the line counter is incremented.
	 * During the HSYNC being low a small (undetected) VSYNC may happen
	 * that resets the line counter for hires.
	 * @param addTstates The number of tstates to add to the HSYNC tstates counter.
	 * @returns true if line counter was incremented.
	 */
	protected checkHsync(addTstates: number): boolean {
		this.hsyncTstatesCounter += addTstates;

		// Check for HSYNC on or off
		if (this.hsync) {
			// HSYNC is on, check for off
			if (this.hsyncTstatesCounter < this.TSTATES_PER_SCANLINE)
				return false;	// No HSYNC on yet
			// HSYNC off
			this.hsyncTstatesCounter -= this.TSTATES_PER_SCANLINE;
			this.hsync = false;
			logOn && console.log(this.hsyncTstatesCounter, "HSYNC off (high)");
			return false;
		}

		// HSYNC is off, check for on
		if (this.hsyncTstatesCounter < this.TSTATES_PER_SCANLINE - this.TSTATES_OF_HSYNC_LOW)
			return false;	// No HSYNC on yet

		// HSYNC
		this.ulaLineCounter = (this.ulaLineCounter + 1) & 0x07;
		this.lineCounter++;

		// Generate NMI on every HSYNC (if NMI generator is on)
		if (this.stateNmiGeneratorOn) {
			this.z80Cpu.interrupt(true, 0);	// NMI
		}

		this.hsync = true;
		logOn && console.log(this.hsyncTstatesCounter, "HSYNC on (low)");
		return true;
	}


	/** Chroma 81 out port function.
	 * Port $7FEF (01111111 11101111) - OUT:
	 * +---+---+---+---+---+---+---+---+
	 * | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
	 * +---+---+---+---+---+---+---+---+
	 *   |   |   |   |   |   |   |   |
	 *   |   |   |   |   |   +---+---+-------- Border color (format: GRB).
	 *   |   |   |   |   +-------------------- Border color bright bit.
	 *   |   |   |   +------------------------ Mode (0=Character code, 1=Attribute file).
	 *   |   |   +---------------------------- 1=Enable color mode.
	 *   +---+-------------------------------- Reserved for future use (always set to 0)
	 */
	protected chroma81OutPort(port: number, value: number): void {
		this.borderColor = value & 0x0F;
		this.chroma81Mode = (value & 0b0001_0000) >>> 4;	// 0 or 1
		this.chroma81Enabled = (value & 0b0010_0000) !== 0;
	}


	/** Chroma 81 in port function.
	 * Port $7FEF (01111111 11101111) - IN:
	 * +---+---+---+---+---+---+---+---+
	 * | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |
	 * +---+---+---+---+---+---+---+---+
	 *   |   |   |   |   |   |   |   |
	 *   |   |   |   +---+---+---+---+-------- X=Not used (reserved for future use).
	 *   |   |   +---------------------------- 0=Color modes available, i.e. configuration switch 6 is set to ON.
	 *   +---+-------------------------------- X=Not used (reserved for future use).
	 */
	protected chroma81InPort(port: number): number {
		return 0b1101_1111;	// Color modes available (otherwise this function is never called)
	}


	/** Serializes the object.
	 */
	public serialize(memBuffer: MemBuffer) {
		// Write data
		memBuffer.write8(this.prevRregister);
		memBuffer.writeBoolean(this.stateNmiGeneratorOn);
		memBuffer.writeNumber(this.ulaLineCounter);
		memBuffer.writeNumber(this.tstates);
		memBuffer.writeNumber(this.vsyncStartTstates);
		memBuffer.writeNumber(this.hsyncTstatesCounter);
		memBuffer.writeBoolean(this.int38InNextCycle);
		memBuffer.writeBoolean(this.hsync);
		memBuffer.writeBoolean(this.vsync);
		memBuffer.writeBoolean(this.noDisplay);
		memBuffer.write8(this.borderColor);
		memBuffer.write8(this.chroma81Mode);
		memBuffer.writeBoolean(this.chroma81Enabled);
	}


	/** Deserializes the object.
	 */
	public deserialize(memBuffer: MemBuffer) {
		// Read data
		this.prevRregister = memBuffer.read8();
		this.stateNmiGeneratorOn = memBuffer.readBoolean();
		this.ulaLineCounter = memBuffer.readNumber();
		this.tstates = memBuffer.readNumber();
		this.vsyncStartTstates = memBuffer.readNumber();
		this.hsyncTstatesCounter = memBuffer.readNumber();
		this.int38InNextCycle = memBuffer.readBoolean();
		this.hsync = memBuffer.readBoolean();
		this.vsync = memBuffer.readBoolean();
		this.noDisplay = memBuffer.readBoolean();
		this.borderColor = memBuffer.read8();
		this.chroma81Mode = memBuffer.read8();
		this.chroma81Enabled = memBuffer.readBoolean();
	}
}
