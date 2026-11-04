/**
 * Session-log remediation: report the stored logs this build refuses to
 * interpret, and repair the ones this plugin wrote unmarked: through the
 * persistence seam's artifact-maintenance capability and nothing else.
 *
 * The service takes no part in opening files, compressing bytes, or deciding
 * where a session lives. `openArtifactMaintenance` owns the write exclusion,
 * the byte-exact backup, and the contract re-validation before publication;
 * this module only decides *what* to ask for and reports what came back.
 * @module dsh-zotero/remediation/service
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ZoteroRemediationReport, ZoteroRemediationRequest, ZoteroRemediationResult } from './contract.js';
/** The remediation service the host exposes as `ctx.zotero.remediation`. */
export declare class ZoteroRemediationService {
    private readonly ctx;
    constructor(ctx: Context);
    /**
     * Inspect every stored session without touching the disk.
     * @param signal - optional cancellation.
     * @returns the capability, the scan size, and one issue per unreadable session.
     * @throws when the persistence listing itself fails: an unreadable store must
     *   surface as a failed inspection, never as a healthy report.
     */
    inspect(signal?: AbortSignal): Promise<ZoteroRemediationReport>;
    /**
     * Repair the requested sessions, one item per requested id.
     * @param request - the issue ids to repair; never empty.
     * @param signal - optional cancellation.
     * @returns one item per requested id, in request order.
     * @throws when the persistence listing fails.
     */
    execute(request: ZoteroRemediationRequest, signal?: AbortSignal): Promise<ZoteroRemediationResult>;
    /**
     * Repair one session. Every path returns an item; none writes outside the
     * seam, and none rolls back: a rollback would be a second, unvalidated write.
     */
    private repair;
}
//# sourceMappingURL=service.d.ts.map