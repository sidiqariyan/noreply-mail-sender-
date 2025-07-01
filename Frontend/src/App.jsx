import React, { useState, useEffect } from "react";

const App = () => {
  const [recipients, setRecipients] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [fromName, setFromName] = useState("No Reply");
  const fromEmail = "noreply@vedive.com";
  const [jobId, setJobId] = useState("");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);

  // Fetch all jobs from the backend
  const fetchJobs = async () => {
    try {
      const response = await fetch("https://vedive.com:5000/api/jobs");
      const data = await response.json();
      setJobs(data);
    } catch (error) {
      console.error("Error fetching jobs:", error);
    }
  };

  // Fetch job status by jobId
  const fetchJobStatus = async (id) => {
    try {
      const response = await fetch(`https://vedive.com:5000/api/job/${id}`);
      const data = await response.json();
      alert(JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Error fetching job status:", error);
    }
  };

  // Send bulk emails
  const sendBulkEmails = async () => {
    setLoading(true);
    try {
      const response = await fetch("https://vedive.com:5000/api/send-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients: recipients.split(",").map((email) => email.trim()),
          subject,
          message,
          fromName,
          fromEmail,
        }),
      });
      const data = await response.json();
      if (data.success) {
        setJobId(data.jobId);
        alert(`Bulk email job started with Job ID: ${data.jobId}`);
        fetchJobs(); // Refresh jobs list
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error("Error sending bulk emails:", error);
    } finally {
      setLoading(false);
    }
  };

  // Delete a job
  const deleteJob = async (id) => {
    try {
      const response = await fetch(`https://vedive.com:5000/api/job/${id}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (data.success) {
        alert("Job deleted successfully!");
        fetchJobs(); // Refresh jobs list
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error("Error deleting job:", error);
    }
  };

  // Load jobs on component mount
  useEffect(() => {
    fetchJobs();
  }, []);

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case 'completed': return 'bg-green-500';
      case 'running': return 'bg-yellow-500';
      case 'failed': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  const getProgressPercentage = (processed, total) => {
    if (!total || total === 0) return 0;
    return Math.round((processed / total) * 100);
  };

  return (
    <div className="max-w-6xl mx-auto p-8 bg-gray-50 min-h-screen">
      <div className="bg-white rounded-xl p-8 shadow-lg mb-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">
            📧 Email Sender
          </h1>
          <p className="text-gray-600 text-lg">
            Send bulk emails efficiently and track their progress
          </p>
        </div>

        {/* Bulk Email Form */}
        <div className="mb-8">
          <h2 className="text-2xl font-semibold text-gray-700 mb-6 pb-2 border-b-2 border-gray-200">
            📤 Compose Email
          </h2>
          
          <div className="grid gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Recipients (comma-separated)
              </label>
              <textarea
                placeholder="john@example.com, jane@example.com, ..."
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                rows="3"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                From Name
              </label>
              <input
                type="text"
                placeholder="Your Name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-sm text-gray-500 mt-1">
                Emails will be sent from: <span className="font-mono bg-gray-100 px-2 py-1 rounded">noreply@vedive.com</span>
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Subject
              </label>
              <input
                type="text"
                placeholder="Enter email subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Message
              </label>
              <textarea
                placeholder="Enter your email message..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows="6"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
            </div>

            <button
              onClick={sendBulkEmails}
              disabled={loading}
              className={`w-full py-4 px-6 rounded-lg font-semibold text-white text-lg transition-all duration-200 ${
                loading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg transform hover:scale-[1.02]'
              }`}
            >
              {loading ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Sending...
                </span>
              ) : (
                '🚀 Send Bulk Emails'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Jobs List */}
      <div className="bg-white rounded-xl p-8 shadow-lg">
        <h2 className="text-2xl font-semibold text-gray-700 mb-6 pb-2 border-b-2 border-gray-200">
          📊 Email Jobs
        </h2>
        
        {jobs.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-6xl mb-4">📭</div>
            <p className="text-gray-500 text-lg">No email jobs yet</p>
            <p className="text-gray-400">Start by sending your first bulk email</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {jobs.map((job) => (
              <div
                key={job.jobId}
                className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow duration-200"
              >
                <div className="flex flex-wrap items-center justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <span className={`inline-block w-3 h-3 rounded-full ${getStatusColor(job.status)}`}></span>
                    <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                      {job.jobId}
                    </span>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-sm font-medium capitalize ${
                    job.status?.toLowerCase() === 'completed' ? 'bg-green-100 text-green-800' :
                    job.status?.toLowerCase() === 'running' ? 'bg-yellow-100 text-yellow-800' :
                    job.status?.toLowerCase() === 'failed' ? 'bg-red-100 text-red-800' :
                    'bg-gray-100 text-gray-800'
                  }`}>
                    {job.status || 'Unknown'}
                  </span>
                </div>

                <div className="grid md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <span className="text-sm text-gray-500">Total Emails:</span>
                    <span className="ml-2 font-semibold text-gray-800">{job.total}</span>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">Processed:</span>
                    <span className="ml-2 font-semibold text-gray-800">{job.processed}</span>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="mb-4">
                  <div className="flex justify-between text-sm text-gray-600 mb-1">
                    <span>Progress</span>
                    <span>{getProgressPercentage(job.processed, job.total)}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${getProgressPercentage(job.processed, job.total)}%` }}
                    ></div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => fetchJobStatus(job.jobId)}
                    className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg font-medium transition-colors duration-200"
                  >
                    👁️ View Status
                  </button>
                  <button
                    onClick={() => deleteJob(job.jobId)}
                    className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium transition-colors duration-200"
                  >
                    🗑️ Delete Job
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;