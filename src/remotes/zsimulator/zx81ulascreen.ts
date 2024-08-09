
import {Serializable, MemBuffer} from "../../misc/membuffer";
import {SimulatedMemory} from "./simulatedmemory";
import {Z80Ports} from "./z80ports";


/** Handles the ZX81 ULA screen.
 * Interrupts:
 * 0x0038: Mode 1 interrupt. Called 192+ times for the lines.
 * 0x0066: NMI interrupt.
 */
export class Zx81UlaScreen implements Serializable {
	// The vsync time of the ULA.
	protected static VSYNC_TIME = 0.020;	// 20ms

	// The memory model. Used to obtain the address of the dfile.
	protected memory: SimulatedMemory;

	// The time since the last vertical interrupt.
	protected time: number;

	// A function that is called when the vertical interrupt is generated.
	protected vertInterruptFunc: () => void;

	// The state of the NMI generator
	protected stateNmiGeneratorOn: boolean = false;

	// The state of the HSYNC generator
	protected stateHsyncGeneratorOn: boolean = false;

	// The original memory read function.
	public memoryRead8: (addr64k: number) => number;

	// For debug measuring the time between two vertical interrupts.
	//protected lastIntTime: number = 0;


	/** Constructor.
	 * @param memoryModel The used memory model.
	 * @param ports The Z80 ports.
	 * @param vertInterruptFunc A function that is called on a vertical interrupt.
	 * Can be used by the caller to sync the display.
	 */
	constructor(memory: SimulatedMemory, ports: Z80Ports, vertInterruptFunc = () => {}) {
		this.memory = memory;
		this.vertInterruptFunc = vertInterruptFunc;
		this.time = 0;

		// Register ULA ports
		ports.registerGenericOutPortFunction(this.outPorts.bind(this));
		ports.registerGenericInPortFunction(this.inPort.bind(this));

		// Remap memory, to intercept the read function
		this.memoryRead8 = memory.read8.bind(memory);
		memory.read8 = this.ulaRead8.bind(this);
	}


	/** Handles the ULA out ports.
	 * 1. out (0xfd),a - turns NMI generator off
	 * 2. out (0xfe),a - turns NMI generator on
	 * (3. in a,(0xfe) - turns HSYNC generator off (if NMI is off))
	 * 4. out (0xff),a - turns HSYNC generator on
	 * Note: the value of a is not ignored.
	 */
	protected outPorts(port: number, _data: number): void {
		// Check for address line A0 = LOW
		if ((port & 0x01) === 0) {
			//
		}
		// NMI generator off?
		if (port === 0xfd) {
			// Yes
			this.stateNmiGeneratorOn = false;
		}
		// NMI generator on?
		else if (port === 0xfe) {
			// Yes
			this.stateNmiGeneratorOn = true;
		}
		// HSYNC on?
		else if (port === 0xff) {
			// Yes
			this.stateHsyncGeneratorOn = true;
		}
	}


	/** Intercepts reading from the memory.
	 * For everything where A15 is set and data bit 6 is low, NOPs are returned.
	 * When databit 6 is set it is expected to be the HALT instruction.
	 */
	public ulaRead8(addr64k: number): number {
		// Read data from memory
		const data = this.memoryRead8(addr64k);
		// Check if above 32k, and data bit 6 is low.
		// Then return NOPs.
		// TODO: Do I need to check also for opcode fetch?
		if (addr64k & 0x8000) {
			// Bit 15 is set
			// Check if bit 6 is low
			if ((data & 0b01000000) === 0) {
				// Return a NOP
				return 0x00;
			}
		}
		// Otherwise return the normal value
		return data;
	}


	/** Handles the ULA in port.
	 * 1. ...
	 * 2. ...
	 * 3. in a,(0xfe) - turns HSYNC generator off (if NMI is off)
	 *    and starts the vertical sync (VSYNC) signal.
	 * 4. ...
	 */
	protected inPort(port: number): number | undefined {
		// HSYNC off?
		if (port === 0xfe) {
			// Yes
			this.stateHsyncGeneratorOn = false;
		}
		return undefined;
	}


	/** Executes the ULA. The ZX81 ULA may grab tstates from
	 * the CPU to simulate the NMI interrupt.
	 * @param cpuFreq The CPU frequency in Hz.
	 * @param currentTstates The t-states that were just used by
	 * DMA or CPU.
	 * @returns The number of t-states the ULA provoked NMI
	 * would have taken.
	 * Note: this is not very accurate.
	 */
	public execute(cpuFreq: number, currentTstates: number): number {
		let tstates = 0;
		// Check for vertical interrupt
		this.time += currentTstates / cpuFreq;
		if (this.time >= Zx81UlaScreen.VSYNC_TIME) {
			this.vertInterruptFunc();
			// Measure time
			// const timeInMs = Date.now();27
			// const timeDiff = timeInMs - this.lastIntTime;
			// console.log("VSYNC: " + timeDiff + "ms");
			// this.lastIntTime = timeInMs;
		}
		// Calculate time inside vertical sync
		this.time %= Zx81UlaScreen.VSYNC_TIME;
		// Check if inside "drawing" area: ca. 3.8ms - 16.1ms (for 20ms)
		const upper = 0.0161;	// 16.1 ms
		const lower = 0.0038;	// 3.8 ms
		if (this.time > lower && this.time < upper) {
			// Use up the remaining tstates
			tstates = Math.ceil((upper - this.time) * cpuFreq);
			this.time = upper;
		}
		return tstates;
	}


	/** Returns the dfile.
	 * @returns The dfile as a UInt8Array.
	 */
	public getUlaScreen(): Uint8Array {
		// Get the content of the D_FILE system variable (2 bytes).
		const dfile_ptr = this.memory.getMemory16(0x400c);
		// 24 lines of 33 bytes (could be less).
		return this.memory.readBlock(dfile_ptr, 33 * 24);
	}


	/** Serializes the object.
	 */
	public serialize(memBuffer: MemBuffer) {
		// Write passed time
		memBuffer.writeNumber(this.time);
	}


	/** Deserializes the object.
	 */
	public deserialize(memBuffer: MemBuffer) {
		// Read passed time
		this.time = memBuffer.readNumber();
	}
}
