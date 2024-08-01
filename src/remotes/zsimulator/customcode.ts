import {EventEmitter} from 'events';
import {LogZsimCustomCode} from '../../log';
import {Utility} from '../../misc/utility';
import {readFileSync} from 'fs';
import {MemBuffer, Serializable} from '../../misc/membuffer';



/**
 * A class that communicates directly with the custom javascript code.
 * The problem here is that an infinite loop in the custom code can make DeZog hang.
 * It is not possible to move this to worker threads as this would mean every
 * Z80 instruction would have to be executed asynchronously (performance penalty).
 * The problem can be solved if the Z80 simulator is completely moved to a webview.
 */
export class CustomCodeAPI extends EventEmitter {
	// The t-states that have passesd since start of simulation/start of debug session which starts at 0.
	public tstates: number = 0;

	// If the code is run from a unit test it contains the unit test (assembler code) label.
	// Otherwise it is undefined.
	public unitTestLabel: string | undefined;


	// Pointer to the object who will receive 'sendToCustomUi'.
	protected parent: CustomCode;

	/**
	 * Constructor.
	 * @param parent The custom code class for communication.
	 */
	constructor(parent: CustomCode, unitTestLabel?: string) {
		super();
		this.parent = parent;
		this.unitTestLabel = unitTestLabel;
	}


	/**
	 * Just used to place a breakpoint.
	 */
	public debugBreak() {
		//
	}


	/**
	 * Emits a message. Normally this means it is send to the ZSimulationView.
	 * Is called by the custom javascript code.
	 * User should not overwrite this.
	 * @param message The message object. Should at least contain
	 * a 'command' property plus other properties depending on the
	 * command.
	 */
	public sendToCustomUi(message: any) {
		LogZsimCustomCode.log('sendToCustomUi: ' + JSON.stringify(message));
		// Send message
		this.parent.emit('sendToCustomUi', message);
	}


	/**
	 * A message has been received from the ZSimulationView that
	 * shall be executed by the custom code.
	 * User can leave this undefined if he does not generate any message in
	 * the ZSimulation view.
	 * @param message The message object.
	 */
	public receivedFromCustomUi: (message: any) => void = undefined as any;


	/**
	 * Called when time has advanced.
	 * Can be overwritten by the user.
	 * Note: API.tstates contains the number of t-states passed
	 * since start of simulation/debug session.
	 */
	public tick: () => void = undefined as any;


	/**
	 * Reads from a port.
	 * Should be overwritten by the user if in ports are used.
	 * @param port The port number, e.g. 0x8000
	 * @return A value, e.g. 0x7F.
	 * If no port is found then undefined is returned.
	 */
	public readPort: (port: number) => number | undefined = (port) => undefined;


	/**
	 * Writes to a port.
	 * Should be overwritten by the user if out ports are used.
	 * @param port the port number, e.g. 0x8000
	 * @param value A value to set, e.g. 0x7F.
	 */
	public writePort: (port: number, value: number) => void = (port, value) => {};	// NOSONAR

	/**
	 * Simulates pulsing the processor's INT (or NMI) pin.
	 * Is called for the ULA vertical sync and also from custom code.
	 * @param non_maskable - true if this is a non-maskable interrupt.
	 * @param data - the value to be placed on the data bus, if needed.
	 */
	public generateInterrupt(non_maskable: boolean, data: number) {
		this.parent.emit('interrupt', non_maskable, data);
	}


	/**
	 * This is called once at the start as soon as the UI is ready to
	 * sent and receive message.
	 * You can override this to e.g. sent first initialized values to the UI.
	 * You can also leave this empty and set the values initially from the UI code.
	 * Note: The custom logic is instantiated before the UI.
	 */
	public uiReady: () => void = () => {};	// NOSONAR


	/**
	 * Writes a log.
	 * @param ...args Any arguments.
	 */
	public log(...args) {
		LogZsimCustomCode.log(...args);
	}

}


/**
 * A class to execute custom code in the simulator.
 * It is called by the (Z80) ports and will execute the javascript code.
 * And it also received messages from the ZSimulationview and
 * as well can send messages to the ZSimulationView.
 */
export class CustomCode extends EventEmitter implements Serializable {

	// Function used to add an error to the diagnostics.
	public static addDiagnosticsErrorFunc: ((message: string, severity: 'error' | 'warning', filepath: string, line: number, column: number) => void) | undefined;


	/**
	 * Static method that calls 'eval' with a context.
	 * @param js The js code.
	 * @param context The context to run in.
	 * @param filename File name that is used for error reporting.
	 * @param lineOffset The number added to the lines for error reporting.
	 * Used to skip the preamble.
	 * @param timeout A timeout that occurs if the script takes too long.
	 * Is used to catch any infinite loop. But it does work only on the main
	 * program, executed now. Function that are called later may cause a infinite loop
	 * without a timeout.
	 */
	protected static runInContext(js: string, context: any, filename: string, lineOffset: number, timeout = 2000) {
		try {
			// Run with a timeout of 2000ms. Note: the timeout does not apply if
			// a function (e.g. readPort) is called later unfortunately.
			Utility.runInContext(js, context, timeout, filename, lineOffset, );
		}
		catch (e) {
			// In case of an error try to find where it occurred
			e.message = 'Custom Code: ' + e.message;
			// Add diagnostics message
			if (this.addDiagnosticsErrorFunc && e.position) {
				this.addDiagnosticsErrorFunc(e.message, 'error', e.position.filename, e.position.line, e.position.column);
			}
			// Re-throw
			throw e;
		}
	}


	// The context the javascript code is executed.
	// Remains.
	protected context: any;

	// For 'reload' the js code text is stored here.
	protected jsCode: string;

	// The absolute path is stored here, for error reporting.
	protected jsPath: string;

	// The api object is stored here.
	protected api: CustomCodeAPI;


	/**
	 *  Constructor.
	 * @param jsPath Absolute path to the file.
	 */
	constructor(jsPath: string) {
		super();
		// Load the file
		this.load(jsPath);
	}


	/**
	 * Reloads the custom javascript code.
	 * @param jsPath Absolute path to the file.
	 */
	public load(jsPath: string) {
		// Can throw an error
		this.jsCode = readFileSync(jsPath).toString();
		this.jsPath = jsPath;
	}


	/**
	 * Reloads the custom javascript code.
	 * @param unitTestLabel If called by the unit tests this contains the unit test case label.
	 * Otherwise it is undefined.
	 * @param timeout A timeout that occurs if the script takes too long.
	 * Is used to catch any infinite loop. But it does work only on the main
	 * program, executed now. Function that are called later may cause a infinite loop
	 * without a timeout.
	 */
	public execute(unitTestLabel?: string, timeout = 2000) {
		// Create an API object
		this.api = new CustomCodeAPI(this, unitTestLabel);

		// Create new empty context
		this.context = {tmpAPI: this.api};

		// Add surrounding code
		const preamble = `
// Preamble:
const global = this;
const API = globalThis.tmpAPI;
// 'tmpAPI' is not visible to customer code. Use 'API' instead.
delete global.tmpAPI;

// Entry point for debugging:
API.debugBreak();

// Add a log to show that log starts
API.log('\\n=====================================');
API.log('Custom code: init start');

`;
		const allCode = `${preamble}${this.jsCode}

API.log('Custom code: init end');
API.log('-------------------------------------\\n');`
		// Find line offset
		const lineOffset = Utility.countOccurrencesOf('\n', preamble);

		// Execute/initialize the javascript
		CustomCode.runInContext(
			allCode,
			this.context,	// This fills the context with the complete program.
			this.jsPath,
			-lineOffset,
			timeout
		);
	}


	/**
	 * This is called once at the start as soon as the UI is ready to
	 * sent and receive message.
	 * You can override this to e.g. sent first initialized values to the UI.
	 * You can also leave this empty and set the values initially from the UI code.
	 * Note: The custom logic is instantiated before the UI.
	 */
	public uiReady() {
		if (this.api) {
			LogZsimCustomCode.log('API.uiReady() called.');
			this.api.uiReady();
		}
	}


	/**
	 * Reads from a port.
	 * Calls the custom js code.
	 * @param port The port number, e.g. 0x8000
	 * @return A value, e.g. 0x7F.
	 * If no port is found then undefined is returned.
	 */
	public readPort(port: number): number | undefined {
		this.logTstates();
		LogZsimCustomCode.log('API.readPort(' + Utility.getHexString(port, 4) + 'h)');
		// Catch probably errors.
		let value;
		try {
			value = this.api.readPort(port);
			LogZsimCustomCode.log('  Reading value ' + Utility.getHexString(value, 2) + 'h for port ' + Utility.getHexString(port, 4) + 'h');
		}
		catch (e) {
			this.throwError("Error during executing custom java script in 'readPort': " + e.message);
		}
		return value;	// Might be undefined
	}


	/**
	 * Writes to a port.
	 * Calls the custom js code.
	 * @param port the port number, e.g. 0x8000
	 * @param value A value to set, e.g. 0x7F.
	 */
	public writePort(port: number, value: number) {
		this.logTstates();
		LogZsimCustomCode.log('API.writePort(' + Utility.getHexString(port, 4) + 'h, ' + Utility.getHexString(value, 2) + 'h)');
		// Catch probably errors.
		try {
			this.api.writePort(port, value);
		}
		catch (e) {
			this.throwError("Error during executing custom java script in 'writePort': " + e.message);
		}
	}


	/**
	 * A message has been received from the ZSimulationView that will be
	 * passed to the custom js code.
	 * @param message The message object. Should at least contain
	 * a 'command' property plus other properties depending on the
	 * command.
	 */
	public receivedFromCustomUi(message: any) {
		LogZsimCustomCode.log('API.receivedFromCustomUi: ' + JSON.stringify(message));
		if (this.api.receivedFromCustomUi === undefined) {
			// Log that a message has been received without receiver.
			LogZsimCustomCode.log("  But no custom 'this.receivedFromCustomUi' defined.");
		}
		else {
			// Catch probably errors.
			try {
				this.api.receivedFromCustomUi(message);
			}
			catch (e) {
				this.throwError("Error during executing custom java script in 'API.receivedFromCustomUi': " + e.message);
			}
		}
	}


	/**
	 * This sets the t-states prior to the next API call.
	 * @param tstates The number of tstates since beginning of simulation, beginning of the debug session which starts at 0.
	 */
	public setTstates(tstates: number) {
		this.api.tstates = tstates;
	}


	/**
	 * Logs the t-states.
	 */
	public logTstates() {
		LogZsimCustomCode.log('tick: tstates=' + this.api.tstates);
	}


	/**
	 * A call to inform the custom code about the advanced time.
	 * The user can control through 'timeSteps' in which interval
	 * this is called.
	 */
	public tick() {
		if (this.api.tick == undefined)
			return;	// No interest in 'tick'

		// Catch probably errors.
		try {
			this.logTstates();
			this.api.tick();
		}
		catch (e) {
			this.throwError("Error during executing custom java script in 'tick': " + e.message);
		}
	}


	/**
	 * Logs the error message and throws an exception.
	 * @param errorMessage The error text.
	 */
	protected throwError(errorMessage: string) {
		LogZsimCustomCode.log(errorMessage);
		throw Error(errorMessage);
	}


	/**
	 * Serializes the object.
	 */
	public serialize(memBuffer: MemBuffer) {
		// Write the custom code context (without tmpAPI)
		const contextString = JSON.stringify(this.context);
		//console.log('serialize:', contextString);
		memBuffer.writeString(contextString);
	}


	/**
	 * Deserializes the object.
	 */
	public deserialize(memBuffer: MemBuffer) {
		// Get the  custom code context (without touching the tmpAPI)
		const contextString = memBuffer.readString();
		//console.log('deserialize:', contextString);
		const savedContext = JSON.parse(contextString);
		// Put into used context
		Utility.deepCopyContext(savedContext, this.context);
	}
}
