public class TimelineController {
    @AuraEnabled(cacheable=true)
    public static Object load(String recordId) {
        return TimelineService.getTimelineData('Default', recordId, null);
    }
}
