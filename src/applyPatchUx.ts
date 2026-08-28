export const applyAnywayAction = 'Apply Anyway';
export const cancelApplyAction = 'Cancel';

export const olderPatchesWarning = 'There are older unapplied patches.';
export const olderPatchesWarningDetail =
	'Applying this patch out of order may cause conflicts or produce an incomplete project state.';

export type ApplyWarningPresenter = (
	message: string,
	options: { modal: true; detail: string },
	...actions: string[]
) => Promise<string | undefined>;

export async function confirmOutOfOrderPatchApply(
	olderPatchName: string,
	showWarning: ApplyWarningPresenter,
): Promise<boolean> {
	const selection = await showWarning(
		olderPatchesWarning,
		{
			modal: true,
			detail: `${olderPatchesWarningDetail}\n\nOldest unapplied patch: ${olderPatchName}`,
		},
		applyAnywayAction,
		cancelApplyAction,
	);

	return selection === applyAnywayAction;
}
