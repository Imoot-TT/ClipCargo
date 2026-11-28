// Download and media-derivative records remain database-compatible while
// views consume one common task shape.
(function exposeClipCargoJobModel() {
  function fromDownload(job) {
    return {
      id: `download:${job.id}`, sourceId: job.id, kind: 'download', title: job.title,
      status: job.status, stage: job.stage || 'queued',
      progress: Number.isFinite(job.progressPercent) ? job.progressPercent : null,
      error: job.errorMessage || null, errorMessage: job.errorMessage || null, errorCode: job.errorCode || null,
      updatedAt: job.updatedAt, output: job.filePath || null,
    };
  }

  function fromDerivative(derivative) {
    return {
      id: `processing:${derivative.id}`, sourceId: derivative.id, kind: 'processing', title: derivative.title,
      status: derivative.status, stage: derivative.kind || 'processing',
      progress: Number.isFinite(derivative.progressPercent) ? derivative.progressPercent : null,
      error: derivative.errorMessage || null, errorMessage: derivative.errorMessage || null, errorCode: derivative.errorCode || null,
      updatedAt: derivative.updatedAt, output: derivative.filePath || null,
    };
  }

  function combine(downloads = [], derivatives = []) {
    return [...downloads.map(fromDownload), ...derivatives.map(fromDerivative)]
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }

  globalThis.ClipCargoJobModel = Object.freeze({ fromDownload, fromDerivative, combine });
})();
