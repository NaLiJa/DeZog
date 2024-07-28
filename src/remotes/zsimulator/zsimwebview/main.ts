import {vscode} from "./vscode-import";
import {ZxAudioBeeper, zxAudioBeeper} from "./zxaudiobeeper";
import {UlaScreen} from "./ulascreen";
import {VisualMem} from "./visualmem";
import {joystickObjs, initJoystickPolling} from "./joysticks";
import {UIAPI, UiBit, UiByte} from "./helper";


// HTML element used for the cpu frequency.
let cpuFreq: HTMLLabelElement

// HTML element used for the cpu load.
let cpuLoad: HTMLLabelElement


// For flow control.
let countOfProcessedMessages = 0;

// Message water marks.
// @ts-ignore
const MESSAGE_HIGH_WATERMARK = 100;
const MESSAGE_LOW_WATERMARK = 10;


// The slot HTML elements.
const slots: HTMLElement[] = [];

// For the ULA screen.
let screenImg: HTMLCanvasElement;
let screenImgImgData: ImageData;
let screenImgContext: CanvasRenderingContext2D;

// Holds the HTML (UI) elements for the zxnDMA.
let zxnDmaHtml: {
	blockLength: HTMLLabelElement,
	portAstartAddress: HTMLLabelElement,
	portBstartAddress: HTMLLabelElement,
	transferDirectionPortAtoB: HTMLLabelElement,
	portAmode: HTMLLabelElement,
	portBmode: HTMLLabelElement,
	portAadd: HTMLLabelElement,
	portBadd: HTMLLabelElement,
	portAcycleLength: HTMLLabelElement,
	portBcycleLength: HTMLLabelElement,
	mode: HTMLLabelElement,
	zxnPrescalar: HTMLLabelElement,
	eobAction: HTMLLabelElement,
	readMask: UiByte,
	statusByte: UiByte,
	blockCounter: HTMLLabelElement,
	portAaddressCounter: HTMLLabelElement,
	portBaddressCounter: HTMLLabelElement,
	lastOperation: HTMLLabelElement;
};

// The previous zxnDMA state (used to print changes in bold).
let prevZxnDmaState: any = {};

// Holds the list of elements that were printed in bold (i.e. had changed).
let prevZxnDmaBoldElements: Array<HTMLLabelElement> = [];


//---- Handle Messages from vscode extension --------
window.addEventListener('message', event => {// NOSONAR
	// Count message
	countOfProcessedMessages++;
	if (countOfProcessedMessages >= MESSAGE_LOW_WATERMARK) {
		// Send info to vscode
		vscode.postMessage({
			command: 'countOfProcessedMessages',
			value: countOfProcessedMessages
		});
		countOfProcessedMessages = 0;
	}

	// Process message
	const message = event.data;
	switch (message.command) {
		case 'init':
			// Configuration received. Is received once after 'configRequest' was sent.
			// Is only done once after loading.
			initSimulation(message.audioSampleRate, message.volume);
			break;

		case 'cpuStopped':
			// Z80 CPU was stopped, t-states do not advance.
			if(zxAudioBeeper)
				zxAudioBeeper.stop();
			break;

		case 'update':
			if (message.cpuFreq) {
				cpuFreq.innerHTML = message.cpuFreq
			}

			if (cpuLoad && message.cpuLoad)
				cpuLoad.innerHTML = message.cpuLoad;

			if (message.slotNames) {
				let i = 0;
				for (const slotString of message.slotNames) {
					const slot = slots[i++];
					if (slot)
						slot.textContent = slotString;
				}
			}

			if (message.visualMem) {
				VisualMem.drawVisualMemory(message.visualMem);
			}

			if (message.screenImg) {
				const data = message.screenImg.ulaData;
				const time = message.screenImg.time;
				UlaScreen.drawUlaScreen(screenImgContext, screenImgImgData, data, time);
			}

			if (message.borderColor != undefined) {
				// Convert ZX color to html color
				const htmlColor = UlaScreen.getHtmlColor(message.borderColor);
				// Set color
				screenImg.style.borderColor = htmlColor;
			}

			if (zxAudioBeeper) {
				zxAudioBeeper.resume();
				if (message.audio) {
					const audio = message.audio;
					zxAudioBeeper.writeBeeperSamples(audio);
				}
			}

			if (message.zxnDMA) {
				printZxnDma(message.zxnDMA);
			}
			break;

		case 'receivedFromCustomLogic':
			// Message received from custom code.
			// Call custom UI code
			if (UIAPI.receivedFromCustomLogic) {
				// Unwrap original message:
				const innerMsg = message.value;
				// Process message
				UIAPI.receivedFromCustomLogic(innerMsg);
			}
			break;
	}
});


/** Init: Initializes parts of the simulation.
 * @param audioSampleRate In Hz.
 * @param volume Number in range [0;1.0]
 */
function initSimulation(audioSampleRate: number, volume: number) {

	// Store the cpu_freq_id
	cpuFreq = document.getElementById("cpu_freq_id") as HTMLLabelElement;

	// Store the cpu_load_id
	cpuLoad = document.getElementById("cpu_load_id") as HTMLLabelElement;

	// Store the visual mem image source
	const visualMemCanvas = document.getElementById("visual_mem_img_id") as HTMLCanvasElement;
	if (visualMemCanvas) {
		// Init both
		VisualMem.initCanvas(visualMemCanvas);
	}

	// Slots
	for (let i = 0; ; i++) {
		const slot = document.getElementById("slot" + i + "_id");
		if (!slot)
			break;
		slots.push(slot);
	}

	// Store the screen image source
	screenImg = document.getElementById("screen_img_id") as HTMLCanvasElement;
	if (screenImg) {
		screenImgContext = screenImg.getContext("2d")!;
		screenImgImgData = screenImgContext.createImageData(UlaScreen.SCREEN_WIDTH, UlaScreen.SCREEN_HEIGHT);
	}

	// Get Beeper output object
	const beeperOutput = document.getElementById("beeper.output");
	if (beeperOutput) {
		// Singleton for audio
		ZxAudioBeeper.createZxAudioBeeper(audioSampleRate, beeperOutput);
		if (zxAudioBeeper.sampleRate != audioSampleRate) {
			// Send warning to vscode
			vscode.postMessage({
				command: 'warning',
				text: "Sample rate of " + audioSampleRate + "Hz could not be set. Try setting it to e.g. " + zxAudioBeeper.sampleRate + "Hz instead."
			});
		}
		zxAudioBeeper.setVolume(volume);

		// Get Volume slider
		const volumeSlider = document.getElementById("audio.volume") as HTMLInputElement;
		volumeSlider.value = zxAudioBeeper.getVolume().toString();
	}

	// zxnDMA
	const portAstartAddressHtml = document.getElementById("zxnDMA.portAstartAddress") as HTMLLabelElement;
	if (portAstartAddressHtml) {
		zxnDmaHtml = {
			portAstartAddress: portAstartAddressHtml,
			portBstartAddress: document.getElementById("zxnDMA.portBstartAddress") as HTMLLabelElement,
			blockLength: document.getElementById("zxnDMA.blockLength") as HTMLLabelElement,
			transferDirectionPortAtoB: document.getElementById("zxnDMA.transferDirectionPortAtoB") as HTMLLabelElement,
			portAmode: document.getElementById("zxnDMA.portAmode") as HTMLLabelElement,
			portBmode: document.getElementById("zxnDMA.portBmode") as HTMLLabelElement,
			portAadd: document.getElementById("zxnDMA.portAadd") as HTMLLabelElement,
			portBadd: document.getElementById("zxnDMA.portBadd") as HTMLLabelElement,
			portAcycleLength: document.getElementById("zxnDMA.portAcycleLength") as HTMLLabelElement,
			portBcycleLength: document.getElementById("zxnDMA.portBcycleLength") as HTMLLabelElement,
			zxnPrescalar: document.getElementById("zxnDMA.zxnPrescalar") as HTMLLabelElement,
			mode: document.getElementById("zxnDMA.mode") as HTMLLabelElement,
			eobAction: document.getElementById("zxnDMA.eobAction") as HTMLLabelElement,
			readMask: document.getElementById("zxnDMA.readMask") as UiByte,
			statusByte: document.getElementById("zxnDMA.statusByte") as UiByte,
			blockCounter: document.getElementById("zxnDMA.blockCounter") as HTMLLabelElement,
			portAaddressCounter: document.getElementById("zxnDMA.portAaddressCounter") as HTMLLabelElement,
			portBaddressCounter: document.getElementById("zxnDMA.portBaddressCounter") as HTMLLabelElement,
			lastOperation: document.getElementById("zxnDMA.lastOperation") as HTMLLabelElement
		};
	}

	// Joysticks (Interface II)
	const if2Joy1Fire = document.getElementById("if2.joy1.fire") as UiBit;
	if (if2Joy1Fire) {
		joystickObjs.push({
			fire: if2Joy1Fire,
			up: document.getElementById("if2.joy1.up") as UiBit,
			left: document.getElementById("if2.joy1.left") as UiBit,
			right: document.getElementById("if2.joy1.right") as UiBit,
			down: document.getElementById("if2.joy1.down") as UiBit
		});
		joystickObjs.push({
			fire: document.getElementById("if2.joy2.fire") as UiBit,
			up: document.getElementById("if2.joy2.up") as UiBit,
			left: document.getElementById("if2.joy2.left") as UiBit,
			right: document.getElementById("if2.joy2.right") as UiBit,
			down: document.getElementById("if2.joy2.down") as UiBit
		});
	}

	// Joystick (Kempston)
	const kempstonJoy1Fire = document.getElementById("kempston.joy1.fire") as UiBit;
	if (kempstonJoy1Fire) {
		joystickObjs.push({
			fire: kempstonJoy1Fire,
			up: document.getElementById("kempston.joy1.up") as UiBit,
			left: document.getElementById("kempston.joy1.left") as UiBit,
			right: document.getElementById("kempston.joy1.right") as UiBit,
			down: document.getElementById("kempston.joy1.down") as UiBit,
		});
	}

	// Start joystick polling (if joystick is setup)
	initJoystickPolling();
}


// Set cell to selected or unselected.
function cellSelect(cell, on) {
	cell.tag = on;
	if (on) {
		cell.className = "td_on";
	}
	else {
		cell.className = "td_off";
	}

	// Send request to vscode
	vscode.postMessage({
		command: 'keyChanged',
		value: on,
		key: cell.id
	});
}


// Print zxnDMA values, if changed in bold.
function printZxnDma(zxnDMA) {
	// Remove all bold elements
	for (const elem of prevZxnDmaBoldElements) {
		elem.style.fontWeight = 'normal';
	}
	prevZxnDmaBoldElements = [];
	// Update zxnDMA HTML elements
	if (prevZxnDmaState.blockLength !== zxnDMA.blockLength) {
		zxnDmaHtml.blockLength.innerHTML = "0x" + zxnDMA.blockLength.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.blockLength.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.blockLength);
	}
	if (prevZxnDmaState.portAstartAddress !== zxnDMA.portAstartAddress) {
		zxnDmaHtml.portAstartAddress.innerHTML = "0x" + zxnDMA.portAstartAddress.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.portAstartAddress.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portAstartAddress);
	}
	if (prevZxnDmaState.transferDirectionPortAtoB !== zxnDMA.transferDirectionPortAtoB) {
		zxnDmaHtml.transferDirectionPortAtoB.innerHTML = zxnDMA.transferDirectionPortAtoB ? '=>' : '<=';
		zxnDmaHtml.transferDirectionPortAtoB.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.transferDirectionPortAtoB);
	}
	if (prevZxnDmaState.portBstartAddress !== zxnDMA.portBstartAddress) {
		zxnDmaHtml.portBstartAddress.innerHTML = "0x" + zxnDMA.portBstartAddress.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.portBstartAddress.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portBstartAddress);
	}
	if (prevZxnDmaState.portAaddressCounterRR34 !== zxnDMA.portAaddressCounterRR34) {
		zxnDmaHtml.portAaddressCounter.innerHTML = "0x" + zxnDMA.portAaddressCounterRR34.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.portAaddressCounter.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portAaddressCounter);
	}
	if (prevZxnDmaState.portBaddressCounterRR56 !== zxnDMA.portBaddressCounterRR56) {
		zxnDmaHtml.portBaddressCounter.innerHTML = "0x" + zxnDMA.portBaddressCounterRR56.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.portBaddressCounter.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portBaddressCounter);
	}
	if (prevZxnDmaState.blockCounterRR12 !== zxnDMA.blockCounterRR12) {
		zxnDmaHtml.blockCounter.innerHTML = "0x" + zxnDMA.blockCounterRR12.toString(16).toUpperCase().padStart(4, '0');
		zxnDmaHtml.blockCounter.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.blockCounter);
	}
	if (prevZxnDmaState.portAmode !== zxnDMA.portAmode) {
		zxnDmaHtml.portAmode.innerHTML = zxnDMA.portAmode;
		zxnDmaHtml.portAmode.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portAmode);
	}
	if (prevZxnDmaState.portBmode !== zxnDMA.portBmode) {
		zxnDmaHtml.portBmode.innerHTML = zxnDMA.portBmode;
		zxnDmaHtml.portBmode.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portBmode);
	}
	if (prevZxnDmaState.portAadd !== zxnDMA.portAadd) {
		zxnDmaHtml.portAadd.innerHTML = zxnDMA.portAadd;
		zxnDmaHtml.portAadd.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portAadd);
	}
	if (prevZxnDmaState.portBadd !== zxnDMA.portBadd) {
		zxnDmaHtml.portBadd.innerHTML = zxnDMA.portBadd;
		zxnDmaHtml.portBadd.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portBadd);
	}
	if (prevZxnDmaState.portAcycleLength !== zxnDMA.portAcycleLength) {
		zxnDmaHtml.portAcycleLength.innerHTML = zxnDMA.portAcycleLength;
		zxnDmaHtml.portAcycleLength.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portAcycleLength);
	}
	if (prevZxnDmaState.portBcycleLength !== zxnDMA.portBcycleLength) {
		zxnDmaHtml.portBcycleLength.innerHTML = zxnDMA.portBcycleLength
		zxnDmaHtml.portBcycleLength.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.portBcycleLength);
	}
	if (prevZxnDmaState.zxnPrescalar !== zxnDMA.zxnPrescalar) {
		zxnDmaHtml.zxnPrescalar.innerHTML = zxnDMA.zxnPrescalar;
		zxnDmaHtml.zxnPrescalar.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.zxnPrescalar);
	}
	if (prevZxnDmaState.mode !== zxnDMA.mode) {
		zxnDmaHtml.mode.innerHTML = zxnDMA.mode;
		zxnDmaHtml.mode.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.mode);
	}
	if (prevZxnDmaState.eobAction !== zxnDMA.eobAction) {
		zxnDmaHtml.eobAction.innerHTML = zxnDMA.eobAction;
		zxnDmaHtml.eobAction.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.eobAction);
	}
	if (prevZxnDmaState.readMask !== zxnDMA.readMask) {
		zxnDmaHtml.readMask.digitvalue = zxnDMA.readMask;
	}
	if (prevZxnDmaState.lastReadSequenceBit !== zxnDMA.lastReadSequenceBit) {
		zxnDmaHtml.readMask.bytevalue = zxnDMA.lastReadSequenceBit;
	}
	if (prevZxnDmaState.statusByte !== zxnDMA.statusByte) {
		zxnDmaHtml.statusByte.digitvalue = zxnDMA.statusByte;
	}
	if (prevZxnDmaState.lastOperation !== zxnDMA.lastOperation) {
		zxnDmaHtml.lastOperation.innerHTML = zxnDMA.lastOperation;
		zxnDmaHtml.lastOperation.style.fontWeight = 'bold';
		prevZxnDmaBoldElements.push(zxnDmaHtml.lastOperation);
	}
	// Remember previous state
	prevZxnDmaState = zxnDMA;
}


// Toggle the cell.
globalThis.cellClicked = function (cell) {
	cell.tag = !cell.tag;
	cellSelect(cell, cell.tag);
}

// Toggle the cell and the corresponding bit
globalThis.togglePortBit = function (cell, port, bitByte) {
	// Send request to vscode
	vscode.postMessage({
		command: 'portBit',
		value: {port: port, on: cell.bitvalue, bitByte: bitByte}
	});
}

// Toggle the cell and the corresponding bit.
// Inverts the bit before sending.
// I.e. Active=LOW
globalThis.togglePortBitNeg = function (cell, port, bitByte) {
	// Send request to vscode
	vscode.postMessage({
		command: 'portBit',
		value: {port: port, on: !cell.bitvalue, bitByte: bitByte}
	});
}

// Find right cell for keycode.
function findCell(keyCode) {
	// Find correspondent cell
	const cell = document.getElementById("key_" + keyCode);
	return cell;
}


// "Copy all HTML" button-- >

// Copies the complete html of the document to the clipboard.
globalThis.copyHtmlToClipboard = function () {
	const copyText = document.documentElement.innerHTML;
	(async () => {
		await navigator.clipboard.writeText(copyText);
	})();
}


// Reload the javascript business logic.
globalThis.reloadCustomLogicAndUi = function () {
	// Send request to vscode
	vscode.postMessage({
		command: 'reloadCustomLogicAndUi'
	});
}


// Called when the volume was changed by the user.
globalThis.volumeChanged = function (volumeStr: string) {
	// Convert to number
	const volume = parseFloat(volumeStr);
	// Inform beeper
	zxAudioBeeper.setVolume(volume);
	// Inform vscode
	vscode.postMessage({
		command: 'volumeChanged',
		value: volume
	});
}


// Handle key down presses.
document.addEventListener('keydown', keydown);
function keydown(e) {
	// Find correspondent cell
	const cell = findCell(e.code);
	cellSelect(cell, true);
}


// Handle key up presses.
document.addEventListener('keyup', keyup);
function keyup(e) {
	// Find correspondent cell
	const cell = findCell(e.code);
	cellSelect(cell, false);
}


// Handle initial load.
window.addEventListener('load', () => {
	// Inform vscode that page was loaded.
	vscode.postMessage({
		command: 'loaded'
	});
});
