export const CANVAS_READ_ROUTES = [
  { name: "courses", method: "GET", endpoint: "/api/v1/courses" },
  { name: "modules", method: "GET", endpoint: "/api/v1/courses/:courseId/modules" },
  { name: "assignments", method: "GET", endpoint: "/api/v1/courses/:courseId/assignments" },
  { name: "announcements", method: "GET", endpoint: "/api/v1/announcements" },
  { name: "syllabus", method: "GET", endpoint: "/api/v1/courses/:courseId" },
  { name: "module-page", method: "GET", endpoint: "/api/v1/courses/:courseId/pages/:pageUrl" },
  { name: "files", method: "GET", endpoint: "/api/v1/courses/:courseId/files" },
  { name: "planner-items", method: "GET", endpoint: "/api/v1/planner/items" },
  { name: "calendar-events", method: "GET", endpoint: "/api/v1/calendar_events" },
  {
    name: "discussion-topics",
    method: "GET",
    endpoint: "/api/v1/courses/:courseId/discussion_topics",
  },
  { name: "quizzes", method: "GET", endpoint: "/api/v1/courses/:courseId/quizzes" },
  { name: "quiz", method: "GET", endpoint: "/api/v1/courses/:courseId/quizzes/:quizId" },
  {
    name: "own-submission",
    method: "GET",
    endpoint: "/api/v1/courses/:courseId/assignments/:assignmentId/submissions/self",
  },
] as const
