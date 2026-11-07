// Meetings domain routes — PRD §8.2, closing the gap flagged in the
// ABION demo seed's knownGaps. Flat `meetings` resource (create/read/
// update/delete), same shape as leave.ts/automation.ts — no membership-
// fallback branching here (unlike projects.ts): meetings has no
// per-meeting ACL of its own in the PRD, just an org-wide grant.
//
// The recording sub-routes (/:id/recordings, /recordings/unmatched,
// /recordings/:recordingId/link) are gated on the SAME `meetings`
// resource, not a separate one — reviewing/linking a recording is an
// extension of managing meetings, not a distinct capability an org would
// ever want to grant independently.
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '../plugins/rbac.js';
import {
  archiveMeeting,
  createMeeting,
  getMeeting,
  listMeetings,
  restoreMeeting,
  updateMeeting,
} from '../services/meetingService.js';
import {
  listRecordingsForMeeting,
  listRecordingsNeedingReview,
  manuallyLinkRecording,
} from '../services/meetingRecordingService.js';
import type { CreateMeetingInput, MeetingLocationType, UpdateMeetingInput } from '@nexus/shared';

const VALID_LOCATION_TYPES: MeetingLocationType[] = ['physical', 'zoom', 'google_meet'];

function isValidLocationType(value: unknown): value is MeetingLocationType {
  return typeof value === 'string' && VALID_LOCATION_TYPES.includes(value as MeetingLocationType);
}

export async function registerMeetingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'meetings'." });
      return;
    }
    const q = req.query as { from?: string; to?: string; includeArchived?: string };
    const meetings = await listMeetings(user.orgId, {
      from: q.from,
      to: q.to,
      includeArchived: q.includeArchived === 'true',
    });
    reply.send({ meetings });
  });

  app.get('/recordings/unmatched', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'meetings'." });
      return;
    }
    const recordings = await listRecordingsNeedingReview(user.orgId);
    reply.send({ recordings });
  });

  app.get('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'meetings'." });
      return;
    }
    const { id } = req.params as { id: string };
    const meeting = await getMeeting(user.orgId, id);
    if (!meeting) {
      reply.status(404).send({ error: 'not_found', message: 'Meeting not found.' });
      return;
    }
    reply.send(meeting);
  });

  app.get('/:id/recordings', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'read'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'read' permission on 'meetings'." });
      return;
    }
    const { id } = req.params as { id: string };
    const meeting = await getMeeting(user.orgId, id);
    if (!meeting) {
      reply.status(404).send({ error: 'not_found', message: 'Meeting not found.' });
      return;
    }
    const recordings = await listRecordingsForMeeting(user.orgId, id);
    reply.send({ recordings });
  });

  app.post('/', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'create'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'create' permission on 'meetings'." });
      return;
    }
    const body = req.body as Partial<CreateMeetingInput>;
    if (!body?.title?.trim()) {
      reply.status(400).send({ error: 'invalid_body', message: 'title is required.' });
      return;
    }
    if (!isValidLocationType(body.locationType)) {
      reply.status(400).send({ error: 'invalid_body', message: `locationType must be one of ${VALID_LOCATION_TYPES.join(', ')}` });
      return;
    }
    if (!body.startTime || Number.isNaN(Date.parse(body.startTime))) {
      reply.status(400).send({ error: 'invalid_body', message: 'startTime (ISO timestamp) is required.' });
      return;
    }

    const meeting = await createMeeting(
      user.orgId,
      {
        title: body.title.trim(),
        locationType: body.locationType,
        locationDetail: body.locationDetail,
        startTime: body.startTime,
        endTime: body.endTime,
        organizerUserId: body.organizerUserId ?? user.userId,
        zoomMeetingId: body.zoomMeetingId,
        notes: body.notes,
        agenda: body.agenda,
        inviteeUserIds: body.inviteeUserIds,
        externalEmails: body.externalEmails,
      },
      user.userId
    );
    reply.status(201).send(meeting);
  });

  app.patch('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'meetings'." });
      return;
    }
    const { id } = req.params as { id: string };
    const body = req.body as UpdateMeetingInput;
    if (body.locationType !== undefined && !isValidLocationType(body.locationType)) {
      reply.status(400).send({ error: 'invalid_body', message: `locationType must be one of ${VALID_LOCATION_TYPES.join(', ')}` });
      return;
    }
    const meeting = await updateMeeting(user.orgId, id, body, user.userId);
    if (!meeting) {
      reply.status(404).send({ error: 'not_found', message: 'Meeting not found.' });
      return;
    }
    reply.send(meeting);
  });

  app.delete('/:id', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'delete'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'delete' permission on 'meetings'." });
      return;
    }
    const { id } = req.params as { id: string };
    const meeting = await archiveMeeting(user.orgId, id, user.userId);
    if (!meeting) {
      reply.status(404).send({ error: 'not_found', message: 'Meeting not found or already archived.' });
      return;
    }
    reply.send(meeting);
  });

  app.post('/:id/restore', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'meetings'." });
      return;
    }
    const { id } = req.params as { id: string };
    const meeting = await restoreMeeting(user.orgId, id, user.userId);
    if (!meeting) {
      reply.status(404).send({ error: 'not_found', message: 'Meeting not found or not archived.' });
      return;
    }
    reply.send(meeting);
  });

  // Manual resolution step for an 'ambiguous' or 'unmatched' recording
  // (meetingRecordingService.ts's own header explains why those two
  // states are never auto-resolved). Gated on 'update' — linking a
  // recording is an edit to that meeting's data, same permission level
  // as PATCH /:id.
  app.post('/recordings/:recordingId/link', async (req, reply) => {
    const user = req.sessionUser!;
    if (!(await hasPermission(user, 'meetings', 'update'))) {
      reply.status(403).send({ error: 'forbidden', message: "Missing 'update' permission on 'meetings'." });
      return;
    }
    const { recordingId } = req.params as { recordingId: string };
    const body = req.body as { meetingId?: string };
    if (!body?.meetingId) {
      reply.status(400).send({ error: 'invalid_body', message: 'meetingId is required.' });
      return;
    }
    const linked = await manuallyLinkRecording(user.orgId, recordingId, body.meetingId);
    if (!linked) {
      reply.status(404).send({
        error: 'not_found',
        message: 'Recording not found, already matched, or meetingId does not exist in this org.',
      });
      return;
    }
    reply.send(linked);
  });
}
