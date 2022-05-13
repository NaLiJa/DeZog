import * as vscode from 'vscode';
import {CustomCode} from './remotes/zsimulator/customcode';


/**
 * A singleton that manages diagnostics. I.e. errors found in the
 * peripherals js code.
 */
export class DiagnosticsHandler {

	// The diagnostics collection.
	protected static diagnosticsCollection: vscode.DiagnosticCollection;


	/**
	 * Subscribes the diagnostics.
	 */
	public static Init(context: vscode.ExtensionContext) {
		this.diagnosticsCollection = vscode.languages.createDiagnosticCollection("DeZog");
		context.subscriptions.push(this.diagnosticsCollection);
		CustomCode.addDiagnosticsErrorFunc = this.add;
	}

	/**
	 * Clears all diagnostics messages.
	 * E.g. called at start of unit tests or at start of a
	 * debug session.
	 */
	public static clear() {
		this.diagnosticsCollection.clear();
	}


	/**
	 * Adds a diagnostics message for a file.
	 * @param message The shown message.
	 * @param severity 'error' or 'warning'.
	 * @param filepath Absolute path to the file.
	 * @param line The line number.
	 * @param column The column number.
	 */
	public static add(message: string, severity: 'error'|'warning', filepath: string, line: number, column = 0) {
		const uri = vscode.Uri.file(filepath);
		const range = new vscode.Range(line, column, line, column);
		const diagSeverity = (severity == 'error') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
		const diagnostic = new vscode.Diagnostic(range, message, diagSeverity);
		diagnostic.source = 'DeZog';
		this.diagnosticsCollection.set(uri, [diagnostic]);
	}
}

